/*
This script interacts with a backend of JasperSoft, which is an enterprise application for creating charts and other reports based on a set of data -- sort of like an online Microsoft Excel for businesses.

This node script intends to change the default input values of a series of Jasper reports based on a simple JSON config file.

Jaspersoft has a somewhat confusing API.  That is, they do have a RESTful API, but it's pretty buggy, .   After struggling to implement this with the RESTful API, I got in touch with JasperSoft who confirmed that this was not possible (despite the documentation suggesting that it was).  So I had to hunt down the data and change it manually.  After experimenting with the Jasper's underlying postgres database, I finally determined that I would actually have to change the XML files stored in the database. 

There are a few different XML files for representing a single Jasper report.  This script pulls down the XML files for each report, and sets the defaults for each.

*/


'use strict';

setDefaults(function (err, result) {
  if (err){console.error(err);}
  else{console.log(result);}});

function setDefaults(cb) {

  var
    fs = require ('fs'),
    xml2js = require('xml2js'),
    S = require('string'),
    jasper = require('./util/jasper'),
    _ = require('lodash'),
    stateXMLSuffix = '_files/stateXML',
    viewJRXMLSuffix = '_files/topicJRXML';

  getConfiguration();

  // allow user to specify config file on command line
  function getConfiguration() {
    if (process.argv.length <= 2) {
      setDefaultsForAllReports(require('./config'));
    } else {
      var filename = process.argv[2];
      fs.readFile(filename, function parseConfigJSON(err, data) {
        if (err) {
          return cb(new Error('Could not open file ' + filename + '\n' + err));
        }
        var dataAsJSON;
        try {
          dataAsJSON = JSON.parse(data.toString());
        }
        catch(err) {
          return cb(new Error('Could not parse JSON ' + '\n' + err));
        }
        setDefaultsForAllReports(dataAsJSON);
      });
    }
  }

// Process all the reports
  function setDefaultsForAllReports(config) {
    var orgs = config.orgs;
    var reports = config.reports;
    handleReport(reports);

    // Iterate through reports
    function handleReport(reports){
      var report = reports.shift();
      if (!report) {
        return cb(null, 'Done setting input values');
      }

      var reportPath = report.reportPath;
      var viewPath = report.viewPath;
      var authOrg = _.findWhere(orgs, {org: report.org});
      var newControls = report.inputControls;
      setDefaultsForSingleReport();

      // Sets Input Controls for a Single Report
      function setDefaultsForSingleReport() {
        var   icValuesDomain, // values acceptable to Jasper
          inputControlMap,    // our own mapping of input controls
          stateXMLAsJSON,
          jrXMLAsJSON;

        createICValueDomain();

        // Gets Jasper's map of acceptable values for input controls
        function createICValueDomain() {
          jasper.getReportInputControls(authOrg, viewPath, function addLabel (err, result){
            if (err) {
              return cb(new Error('Could not get input controls for ' + viewPath + '\n' + err));
            }
            icValuesDomain = result.inputControl;
            readStateXML(viewPath, authOrg);
          });
        }

        function readStateXML(viewPath, authOrg) {
          jasper.getResource(
            authOrg, viewPath + stateXMLSuffix,
            function(err, result) {
              if(err) {
                return cb(new Error('Could not retrieve resource' + viewPath + '\n' + err));
              }
              xml2js.parseString(result, function (err, stateJ) {
                if(err) {
                  return cb(new Error('Could not parse StateXML' + '\n' + err));
                }
                stateXMLAsJSON = stateJ;
                createInputControlMap();
              });
            });
        }

        // our own mapping of input controls
        function createInputControlMap() {
          var oldControls = stateXMLAsJSON.unifiedState.subFilterList[0].subFilter;
          var labelMaps = stateXMLAsJSON.unifiedState.crosstabState[0].rowGroups[0].queryDimension.concat(
            stateXMLAsJSON.unifiedState.crosstabState[0].columnGroups[0].queryDimension);
          inputControlMap = [];
          for (var i=0; i<oldControls.length;i++) {
            var ic = oldControls[i];
            var letterIdx = ic.$.letter;
            var parEx = ic.parameterizedExpressionString;
            var parExArray = parEx.toString().split(' ');
            var internalJasperName = parExArray[0];
            var isSingle = parExArray[1] === '==' ? true : false;
            var externalName = parExArray[2];
            var label = undefined;
            for (var j=0; j<labelMaps.length; j++) {
              var labelMap = labelMaps[j].$;
              if (labelMap.name === internalJasperName) {
                label = labelMap.fieldDisplay;
                break;
              }
            }
            if (! label) {
              return cb(new Error('Could not locate the Input Control label ' + label + ' in stateXML file.'));
            }
            inputControlMap.push({letterIdx: letterIdx, internal: internalJasperName, isSingle: isSingle, external: externalName, label: label});
          }
          rewriteStateXML();
        }

        function rewriteStateXML() {
          // stores the normalized value(s) within the InputControlMap
          function jasperNormalizedValue(isSingle, label, valueForIC) {
            if (isSingle) {
              try {
                return fixICWhitespace(label, valueForIC);
              }
              catch (err) {
                throw (err);
              }
            }
            else {
              var newVals = valueForIC.split(',');
              var normalizedValues = [];
              for (var j=0; j<newVals.length; j++) {
                try {
                  normalizedValues.push(fixICWhitespace(label, newVals[j]));
                }
                catch (err) {
                  throw (err);
                }
              }
              return normalizedValues;
            }

            // Input Control Values must match the whitespace format of Jasper exactly
            function fixICWhitespace(label, val) {
              var unspaced = S(val).collapseWhitespace().s.trim();

              var control = _.findWhere(icValuesDomain, {label: label});
              var options = control.state.options;

              for (var i=0; i<options.length; i++) {
                if (unspaced.trim() === options[i].value.trim()) {
                  return options[i].value;
                }
              }
              // no match was found -- we have an error
              throw new Error('The value ' + val + ' is not valid for the Input Control ' + label);
            }
          }

          var newKeys = _.keys(newControls);
          for (var i=0; i<newKeys.length; i++) {
            var label = newKeys[i];
            var valueForIC = newControls[label];
            var icMapEntry = _.findWhere(inputControlMap, {label: label});
            var newExpressionString;
            try {
              icMapEntry.newJasperVal = jasperNormalizedValue(icMapEntry.isSingle, label, valueForIC);
            }
            catch (err) {
              return cb(err);
            }

            if (icMapEntry.isSingle) {
              newExpressionString = icMapEntry.internal + ' == \'' + icMapEntry.newJasperVal + '\'';
            }
            else  {
              newExpressionString = icMapEntry.internal + ' in (\''+ icMapEntry.newJasperVal.join('\', \'') + '\')';
            }

            var newExpressionArr = [];
            newExpressionArr.push(newExpressionString);

            var letterIdx = icMapEntry.letterIdx;
            var numIdx = letterIdx.charCodeAt(0) - 'A'.charCodeAt(0);

            stateXMLAsJSON.unifiedState.subFilterList[0].subFilter[numIdx].expressionString = newExpressionArr;
          }
          var builder = new xml2js.Builder();
          var xml = builder.buildObject(stateXMLAsJSON);
          xml = S(xml).replaceAll('&apos;', '\'').s;
          xml = S(xml).replaceAll('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n', '').s;
          uploadStateXMLToReport();

          function uploadStateXMLToReport() {
            jasper.putResource(
              authOrg, reportPath + stateXMLSuffix, xml, 'application/xml',
              function(err, response) {
                if(err) {
                  return cb(new Error('Failed to replace stateXML for report ' + reportPath + '\n' + err));
                }
                console.log ('State XML replaced for report ' + reportPath);
                uploadStateXMLToView(xml);
              });
          }

          function uploadStateXMLToView() {
            jasper.putResource(
              authOrg, viewPath + stateXMLSuffix, xml, 'application/xml',
              function (err, response ) {
                if (err) {
                  return cb(new Error('Failed to replace stateXML for view ' + viewPath + '\n' + err));
                }
                console.log ('State XML replaced for view ' + viewPath);
                readJRXML();
              });
          }
        }

        function readJRXML() {
          jasper.getResource(
            authOrg, viewPath + viewJRXMLSuffix,
            function(err, result) {
              if(err) {
                return cb (new Error('Could not retrieve resource' + viewPath + '\n' + err));
              }
              else {
                xml2js.parseString(result, function(err, jrxJ){
                  if(err) {
                    return cb (new Error('Could not parse JRXML' + '\n' + err));
                  }
                  jrXMLAsJSON = jrxJ;
                  rewriteJRXML();
                });
              }});
        }

        function rewriteJRXML() {
          var jrxmlParameters = jrXMLAsJSON.jasperReport.parameter;
          for (var i=0; i<jrxmlParameters.length; i++) {
            var param = jrxmlParameters[i];
            var paramName = param.$.name;
            var icMapEntry = _.findWhere(inputControlMap, {external: paramName});
            if (icMapEntry.newJasperVal) {
              if (icMapEntry.isSingle) {
                param.defaultValueExpression = '"' + icMapEntry.newJasperVal + '"';
              }
              else  {
                param.defaultValueExpression =
                  'java.util.Arrays.asList(new Object[]{"' +
                    icMapEntry.newJasperVal.join('", "')  + '"})';
              }
            }
          }
          var builder = new xml2js.Builder();
          var xml = builder.buildObject(jrXMLAsJSON);
          jasper.putResource(
            authOrg, viewPath + viewJRXMLSuffix, xml, 'application/xml',
            function(err, response) {
              if(err) {
                return cb (new Error('Failed to replace jrxml for view ' + viewPath + '\n' + err));
              }
              setImmediate(function() {handleReport(reports);});
              console.log('JRXML replaced for report ' + viewPath)
              return cb (null, "Input Values have been set in report " + reportPath + " and in view " + viewPath);
            });
        }
      }
    }
  }
}

