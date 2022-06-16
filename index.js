import express from 'express';
import { json } from 'body-parser';
import dotenv from 'dotenv';
import opsgenie from 'opsgenie-sdk';
import morgan from 'morgan';
import passport from 'passport';
import { BasicStrategy } from 'passport-http';
import AnonymousStrategy from 'passport-anonymous';

/* ========================== */
/* CONSTANTS                  */
/* ========================== */
// Incident object key for associated alert IDs
const ASSOCIATED_ALERT_IDS_KEY = 'associatedAlertIDs';
// The metrics this data source can provide
const METRICS = [
    'MTTA'
];

/* ========================== */
/* GLOBALS                    */
/* ========================== */

/* The HTTP Server */
dotenv.config();
const gApp = express();

let gAuthenticationStrategy = null;

/* ========================== */
/* INITIALISATION             */
/* ========================== */

function init() {

    opsgenie.configure({
        'api_key': process.env.OPSGENIE_API_KEY
    });

    // Setup an authentication strategy
    if (process.env.HTTP_USER) {
        passport.use(new BasicStrategy(
            function (username, password, done) {

                if (process.env.HTTP_USER == username && process.env.HTTP_PASS == password) {
                    return done(null, true)
                }

                return done(null, false)
            }
        ));

        gAuthenticationStrategy = 'basic'
    } else {
        // Default ot allowing anonymous access
        passport.use(new AnonymousStrategy())
        gAuthenticationStrategy = 'anonymous'
    }


    // Set up logging etc.
    gApp.use(json());
    gApp.use(morgan('combined')); // We want to log all HTTP requests
    gApp.use(passport.initialize());

    // Set up JSON Date parser so that we read dates back in as Dates rather than Strings
    // See: https://weblog.west-wind.com/posts/2014/jan/06/javascript-json-date-parsing-and-real-dates
    var reISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*))(?:Z|(\+|-)([\d|:]*))?$/;
    var reMsAjax = /^\/Date\((d|-|.*)\)[\/|\\]$/;

    JSON.dateParser = function (key, value) {
        if (typeof value === 'string') {
            var a = reISO.exec(value);
            if (a)
                return new Date(value);
            a = reMsAjax.exec(value);
            if (a) {
                var b = a[1].split(/[-+,.]/);
                return new Date(b[0] ? +b[0] : 0 - +b[1]);
            }
        }
        return value;
    };  
}

// Initialise everything
init();

/* ========================== */
/* PROMISES                   */
/* ========================== */

/**
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {{now: Date, from: Date, to: Date, intervalMs: number, maxDataPoints: number}} window The window to return data in
 * @param {{target: string, refId: string, type: string, data: {}}} target The request target object
 * @param {*} result The result
 */
function getPromisesForMetric(requestId, window, target, result) {
    switch (target.target) {
        case METRICS[0]: return getMTTAPromise(requestId, window, target, result);
    }
}

/**
 * Get the Mean Time to Acknowledge from OpsGenie. This is the time between a problem occuring and the client first getting notified.
 * 
 * Note: This is limited to incident tickets
 * 
 * @param {string} requestId The Request ID from Grafana, e.g. Q123
 * @param {{now: Date, from: Date, to: Date, intervalMs: number, maxDataPoints: number}} window The window to return data in
 * @param {{target: string, refId: string, type: string, data: {}}} target The request target object
 * @param {*} result The result
 */
async function getMTTAPromise(requestId, window, target, result) {

    let incidents = await queryAPI(opsgenie.incident, opsgenie.incident.list, {query: "", sort: "insertedAt", order: "desc"});
    
    let relatedAlertsQueries = [];
    incidents.forEach(incident => {
        // Get the associated alert IDs for each of those alerts and then record that on the incident
        let incidentRelatedAlertsQuery = queryAPI(opsgenie.incident, opsgenie.incident.getAssociatedAlerts, {identifier: incident.id, identifierType: "id", order: "desc"}).then(alertIDs => {incident[ASSOCIATED_ALERT_IDS_KEY] = alertIDs;});
        // Record the queries so we can wait for them all to finish later
        relatedAlertsQueries.push(incidentRelatedAlertsQuery);
    });
    // Wait until we've executed all of the related alerts queries and then make a single API query to get all the alert details together - reduces the number of calls
    await Promise.all(relatedAlertsQueries);
    let alertsQueryString = "alertId: (" + incidents.flatMap(incident => incident[ASSOCIATED_ALERT_IDS_KEY]).join(" OR ") + ")";
    let alerts = await queryAPI(opsgenie.alertV2, opsgenie.alertV2.list, {query: alertsQueryString, sort: "createdAt", order: "desc"});
    // Create a map of alertID: alert for easy referencing
    let alertsMap = Object.fromEntries(alerts.map(alert => [alert.id, alert]));

    // For each incident, work out the ack time
    incidents.forEach(incident => {
        let associatedAlerts = incident[ASSOCIATED_ALERT_IDS_KEY];
        // Problem occurs at creation time of first associated alert
        let incidentStartedDateTime = alerts.filter(alert => associatedAlerts.includes(alert.id)).sort((a,b) => a.createdAt - b.createdAt)[0];
        // Ack occurs at first client notification of incident
        // TODO
    });

    console.log(incidents);

}

/* ========================== */
/* OPSGENIE WRAPPERS          */
/* ========================== */
/**
 * Query the OG API for data
 * 
 * TODO: Caching
 * 
 * @param {*} ogLibrary The Ops Genie library to make the call on, e.g. opsgenie.incident
 * @param {*} ogAPICall The API to call, e.g. opsgenie.incident.list
 * @param {*} queryJSON  The query parameters, e.g. {query: "", sort: "insertedAt", order: "desc"}
 * @param {*[]} [results=[]] Internally used. Maintains a recursively constructed array of results
 * @param {*} [startAt=0] Interally used. The offset index for paged results fetching 
 * @returns {Promise<[]>} of results
 */
 async function queryAPI(ogLibrary, ogAPICall, queryJSON, results = [], startAt = 0) {

    // Set pagination parameters
    queryJSON.offset = startAt;
    queryJSON.limit = 100;
    queryJSON.direction = "next";

    return opsGeniePagedRequest(ogLibrary, ogAPICall, queryJSON).then(response => {
        console.log(response);

        results = results.concat(response.data);
        // If there are more results to get then get them.
        /* 
        Note: In the situation where the number of results is a whole multiple of the limit
        one wasted API call will be made. This cannot be avoided without knowing the full
        number of results, which the API response doesn't currently provide.
        */
        if (response.data.length == queryJSON.limit) {
            // Chain up another promise
            return queryAPI(ogLibrary, ogAPICall, queryJSON, results, startAt + queryJSON.limit);
        }
        return results;

    }).catch(error => {
        console.error(error);
        return results;
    })
}

/**
 * Wrap an OpsGenie library API call in a Promise so that we can handle pagination
 * 
 * @param {*} ogLibrary The Ops Genie library to make the call on, e.g. opsgenie.incident
 * @param {*} ogAPICall The Ops Genie library API call to make, e.g. opsgenie.incident.getAssociatedAlerts
 * @param {*} queryJSON The JSON object defining the query parameters
 * @returns {Promise} that the API call will be made
 */
async function opsGeniePagedRequest(ogLibrary, ogAPICall, queryJSON) {
    return new Promise((resolve, reject) => {
        // Note: Indirect "call" required so that "this" is set appropriately in the function
        ogAPICall.call(ogLibrary, queryJSON, (error, response) => {
            if (error) reject(error);
            resolve(response);
        });
    });
}

/* ========================== */
/* REQUEST PARSING            */
/* ========================== */

/**
 * 
 * @param {*} body 
 * @return {{now: Date, from: Date, to: Date, intervalMs: number, maxDataPoints: number}} The window to return data in
 */
function getWindowFromRequest(body) {
    return {
        now: new Date(),
        from: new Date(body.range.from),
        to: new Date(body.range.to),
        intervalMs: body.intervalMs,
        maxDataPoints: body.maxDataPoints
    }
}

/**
 * 
 * @param {*} body 
 * @return {string} request ID, e.g. Q398
 */
function getRequestIDFromRequest(body) {
    return body.requestId;
}

/**
 * In one of the recent version upgrades (~v8) Grafana changed from using target.data to 
 * target.payload as the mechanism by which the user's request was translated to SimPod. 
 * This method handles that backwards compatibility. Payload is preferred as target.data 
 * no longer formats as a JSON object but as a string.
 * 
 * @param {*} target 
 * @return {*} the JSON request object supplied by the user
 */
function getRequestDetail(target) {

    let requestDetailObject = null;
    if (target.hasOwnProperty('payload')) {
        requestDetailObject = target.payload;
    } else if (target.hasOwnProperty('data')) {
        requestDetailObject = target.data;
    }

    return requestDetailObject;

}

/**
 * Generic function to return the value of a request property from the request object.
 * 
 * @param {*} target The target object
 * @param {*} propertyName The property name for the property to retrieve
 * @param {*} defaultValue An optional default value if a value isn't specified
 * @param {*} valueXFormFunction An optional transform function to mutate the value on read
 * @returns 
 */
function getRequestProperty(target, propertyName, defaultValue = null, valueXFormFunction = (A => A)) {
    // Default status is Deploy Queue
    let value = defaultValue;
    let requestDetail = getRequestDetail(target);
    if (requestDetail != null) {
        if (requestDetail.hasOwnProperty(propertyName)) {
            value = valueXFormFunction(requestDetail[propertyName]);
        }
    }
    return value;
}

/* ========================== */
/* ROUTES                     */
/* ========================== */
// Should return 200 ok. Used for "Test connection" on the datasource config page.
gApp.get('/',
    passport.authenticate(gAuthenticationStrategy, { session: false }),
    (httpReq, httpRes) => {
        httpRes.set('Content-Type', 'text/plain')
        httpRes.send(new Date() + ': OK')
    })

// Test the connection between opsgenie and this project
gApp.get('/test-opsgenie',
    passport.authenticate(gAuthenticationStrategy, { session: false }),
    (httpReq, httpRes) => {
        // TODO
        // gJira.myself.getMyself().then((jiraRes) => {
        //     httpRes.json(jiraRes)
        // }).catch((jiraErr) => {
        //     httpRes.json(JSON.parse(jiraErr))
        // })
    });


// Used by the find metric options on the query tab in panels.
gApp.all('/search',
    passport.authenticate(gAuthenticationStrategy, { session: false }),
    (httpReq, httpRes) => {
        httpRes.json(METRICS);
    });

// Should return metrics based on input.
gApp.post('/query',
    passport.authenticate(gAuthenticationStrategy, { session: false }),
    (httpReq, httpRes) => {

        let result = [];
        let window = getWindowFromRequest(httpReq.body);
        let requestId = getRequestIDFromRequest(httpReq.body);

        let p = [];
        httpReq.body.targets.forEach(target => {
            let ps = getPromisesForMetric(requestId, window, target, result);
            if (ps != null) {
                if (Array.isArray(ps)) {
                    p.push(...ps);
                } else {
                    p.push(ps);
                }
            }
        });

        // Once all promises resolve, return result
        Promise.all(p).then(() => {
            httpRes.json(result)
        });

    });

gApp.listen(3030, '0.0.0.0');

console.info('Server is listening on port 3030');