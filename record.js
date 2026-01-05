'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { networkInterfaces } = require('os');

// Read the API key from the specified file
// const apiKeyPath = 'C:\\Users\\<YOUR_USER_HERE>\\Documents\\My Games\\TrainSimWorld5\\Saved\\Config\\CommAPIKey.txt';
const windows_users_folder = process.env.USERPROFILE || 'DefaultUser';
const apiKeyPath = path.join(windows_users_folder, 'Documents', 'My Games', 'TrainSimWorld6', 'Saved', 'Config', 'CommAPIKey.txt');

// Set to true for miles, false for kilometers
const useMiles = false;

// Route collection configuration
const ENABLE_ROUTE_COLLECTION = true; // Set to false to disable route collection
const ROUTE_COLLECTION_INTERVAL = 125; // ms between GPS coordinate collections

// Route collection storage
const routeCoordinates = [];
let lastRouteCoordinate = null;
let routeCollectionStartTime = null;
let routeCollectionRequestCount = 0;
const discoveredMarkers = [];
const processedMarkers = new Set();
let currentPlayerPosition = null;
let currentGradient = null;
let currentHeight = null;
let routeOutputFilePath = null;

/**
 * Gets the internal IP address of this machine
 */
function getInternalIpAddress() {
  const nets = networkInterfaces();
  
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
      // 'IPv4' is a string in Node <= 17, from 18 it's a number 4
      const familyV4Value = typeof net.family === 'string' ? 'IPv4' : 4;

      if (net.family === familyV4Value && !net.internal) {
        return net.address; // Return the first matching address
      }
    }
  }
  return null; // Return null if no suitable IP is found
}

// Speed conversion factor: m/s to km/h = 3.6, m/s to mph = 2.23694
const speedConversionFactor = useMiles ? 2.23694 : 3.6;

// Distance conversion factor: cm to meters = 100, cm to feet = 30.48
const distanceConversionFactor = useMiles ? 30.48 : 100;

// Timetable data storage
let timetableData = [];

// Track last known distance and target station
let lastDistanceToStation = null;
let lastTargetApiName = null;

/**
 * Loads timetable data from the skeleton file if available
 */
function loadTimetable() {
    // Timetable is now loaded from the JSON skeleton file in initializeRouteFile()
    // This function kept for compatibility but no longer loads from CSV
    console.log('Timetable will be loaded from route skeleton file');
}

/**
 * Converts time string (HH:MM:SS) to seconds since midnight
 */
function timeToSeconds(timeStr) {
    if (!timeStr) return null;
    const parts = timeStr.split(':');
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
}

/**
 * Calculates what should be displayed in the timetable box based on current time
 */
function getTimetableDisplay(currentTimeISO) {
    if (timetableData.length === 0 || !currentTimeISO) {
        return { time: null, label: null, targetApiName: null, showDistance: false };
    }
    
    try {
        // Extract time from ISO8601 string
        const timePart = currentTimeISO.split('T')[1].split('.')[0];
        const currentSeconds = timeToSeconds(timePart);
        
        // Find current position in timetable
        for (let i = 0; i < timetableData.length; i++) {
            const stop = timetableData[i];
            const departureSeconds = timeToSeconds(stop.departure);
            const arrivalSeconds = timeToSeconds(stop.arrival);
            
            // First stop - show departure
            if (i === 0) {
                if (currentSeconds < departureSeconds) {
                    return { time: stop.departure, label: 'DEPARTURE', targetApiName: null, showDistance: false };
                }
            }
            
            // Last stop - only show arrival
            if (i === timetableData.length - 1) {
                return { time: stop.arrival, label: stop.destination, targetApiName: stop.apiName, showDistance: true };
            }
            
            // Current stop departure time hasn't passed yet
            if (departureSeconds && currentSeconds < departureSeconds) {
                return { time: stop.departure, label: 'DEPARTURE', targetApiName: null, showDistance: false };
            }
            
            // Check if we're between this departure and next arrival
            if (i < timetableData.length - 1) {
                const nextStop = timetableData[i + 1];
                const nextArrivalSeconds = timeToSeconds(nextStop.arrival);
                
                if (currentSeconds >= departureSeconds && currentSeconds < nextArrivalSeconds) {
                    return { time: nextStop.arrival, label: nextStop.destination, targetApiName: nextStop.apiName, showDistance: true };
                }
                
                // At next station, before departure
                if (currentSeconds >= nextArrivalSeconds) {
                    const nextDepartureSeconds = timeToSeconds(nextStop.departure);
                    if (nextDepartureSeconds && currentSeconds < nextDepartureSeconds) {
                        return { time: nextStop.departure, label: 'DEPARTURE', targetApiName: null, showDistance: false };
                    }
                }
            }
        }
        
        return { time: null, label: null, targetApiName: null, showDistance: false };
    } catch (err) {
        console.error('Error calculating timetable display:', err.message);
        return { time: null, label: null, targetApiName: null, showDistance: false };
    }
}

// Load timetable on startup
loadTimetable();

/**
 * Initializes the route output file path
 */
function initializeRouteFile() {
    if (!ENABLE_ROUTE_COLLECTION) {
        return;
    }

    // Create output directory if it doesn't exist
    const outputDir = path.join(__dirname, 'unprocessed_routes');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Look for any route skeleton file in unprocessed_routes
    const existingFiles = fs.readdirSync(outputDir)
        .filter(f => f.startsWith('route_') && f.endsWith('.json'))
        .sort()
        .reverse(); // Most recent first
    
    if (existingFiles.length > 0) {
        // Use the first (most recent) skeleton file found
        const skeletonFileName = existingFiles[0];
        routeOutputFilePath = path.join(outputDir, skeletonFileName);
        console.log(`Found existing route skeleton: ${skeletonFileName}`);
        console.log('Route data will be added to this file');
        
        // Load existing data to preserve timetable
        try {
            const existingData = JSON.parse(fs.readFileSync(routeOutputFilePath, 'utf8'));
            if (existingData.timetable && Array.isArray(existingData.timetable)) {
                // Populate timetableData array for HUD display
                timetableData = existingData.timetable;
                console.log(`Loaded timetable with ${timetableData.length} stops from skeleton`);
            }
        } catch (err) {
            console.warn('Warning: Could not load existing skeleton file:', err.message);
        }
    } else {
        // No skeleton found, print warning
        console.warn('⚠ WARNING: No route skeleton file found in unprocessed_routes/');
        console.warn('⚠ Please run extract.js first to create a timetable skeleton');
        console.warn('⚠ Route recording will continue but without timetable data');
        
        // Generate new filename with timestamp as fallback
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
        const fileName = `route_recording_${timestamp}.json`;
        routeOutputFilePath = path.join(outputDir, fileName);
    }
    
    console.log(`Route will be saved to: ${path.basename(routeOutputFilePath)}`);
}

/**
 * Saves the collected route coordinates to a JSON file
 */
function saveRouteData() {
    if (!ENABLE_ROUTE_COLLECTION || !routeOutputFilePath || routeCoordinates.length === 0) {
        return;
    }

    // Check if we're updating an existing skeleton file
    let existingTimetable = null;
    let existingRouteName = 'Route Recording';
    if (fs.existsSync(routeOutputFilePath)) {
        try {
            const existingData = JSON.parse(fs.readFileSync(routeOutputFilePath, 'utf8'));
            if (existingData.timetable && Array.isArray(existingData.timetable)) {
                existingTimetable = existingData.timetable;
            }
            if (existingData.routeName) {
                existingRouteName = existingData.routeName;
            }
        } catch (err) {
            console.warn('Warning: Could not preserve timetable from existing file:', err.message);
        }
    }

    const output = {
        routeName: existingRouteName,
        totalPoints: routeCoordinates.length,
        totalMarkers: discoveredMarkers.length,
        duration: Date.now() - routeCollectionStartTime,
        requestCount: routeCollectionRequestCount,
        coordinates: routeCoordinates,
        markers: discoveredMarkers
    };
    
    // Add timetable if it existed in skeleton
    if (existingTimetable) {
        output.timetable = existingTimetable;
    }

    fs.writeFileSync(routeOutputFilePath, JSON.stringify(output, null, 2));
}

/**
 * Waits for a specified number of milliseconds
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Attempts to read and validate the API key, retrying until valid
 */
async function waitForValidApiKey() {
    let apiKey = '';
    while (!apiKey) {
        try {
            apiKey = fs.readFileSync(apiKeyPath, 'utf8').trim();
            if (!apiKey) {
                throw new Error('CommAPIKey key is empty');
            }
            console.log('CommAPIKey Key loaded successfully');
            return apiKey;
        } catch (err) {
            console.log('Waiting for TSW CommAPIKey ...');
            await sleep(3000);
        }
    }
}

let apiKey = '';
// Wait for valid API key before starting server
(async () => {
    apiKey = await waitForValidApiKey();

/**
 * Deletes the existing subscription before creating new ones
 */
async function deleteSubscription() {
    console.log('Deleting old subscription...');
    try {
        const config = {
            method: 'delete',
            maxBodyLength: Infinity,
            url: 'http://localhost:31270/subscription?Subscription=1',
            headers: { 
                'DTGCommKey': apiKey
            }
        };
        const response = await axios.request(config);
        console.log('Old subscription deleted successfully');
    } catch (err) {
        console.error('Failed to delete old subscription, old subscription may not exist. Error Message:', err.message);
    }
}

// Flag to track if subscriptions have been created
let subscriptionsCreated = false;

// Array of subscription endpoints to create
// For some reason it always seems to fail on the first one, so we include it twice to be sure
const subscriptionEndpoints = [
    '/subscription/TimeOfDay.Data?Subscription=1 ',
    '/subscription/DriverAid.Data?Subscription=1',
    '/subscription/DriverAid.PlayerInfo?Subscription=1',
    '/subscription/DriverAid.TrackData?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetSpeed?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetDirection?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetPowerHandle?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetIsSlipping?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetBrakeGauge_1?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetBrakeGauge_2?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetAcceleration?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetSpeedControlTarget?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetMaxPermittedSpeed?Subscription=1',
    // '/subscription/CurrentDrivableActor.Function.HUD_GetAlerter?Subscription=1',
    // '/subscription/CurrentDrivableActor.Function.HUD_GetAmmeter?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetTractiveEffort?Subscription=1',
    // '/subscription/CurrentDrivableActor.Function.HUD_GetEngineRPM?Subscription=1',
    // '/subscription/CurrentDrivableActor.Function.HUD_GetGearIndex?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetElectricBrakeHandle?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetLocomotiveBrakeHandle?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetTrainBrakeHandle?Subscription=1',
    '/subscription/CurrentDrivableActor.Function.HUD_GetIsTractionLocked?Subscription=1'
    // '/subscription/CurrentDrivableActor.Function.HUD_GetSteamBoilerPressure?Subscription=1',
    // '/subscription/CurrentDrivableActor.Function.HUD_GetSteamChestPressure?Subscription=1',
    // '/subscription/CurrentDrivableActor.Function.HUD_GetCylinderCocks?Subscription=1',
    // '/subscription/CurrentDrivableActor.Function.HUD_GetBoilerWaterLevel?Subscription=1',
    // '/subscription/CurrentDrivableActor.Function.HUD_GetFireboxCoalLevel?Subscription=1',
    // '/subscription/CurrentDrivableActor.Function.HUD_GetBlowerFlow?Subscription=1',
    // '/subscription/CurrentDrivableActor.Function.HUD_GetDamperFlow?Subscription=1',
    // '/subscription/CurrentDrivableActor.Function.HUD_GetReverserCutoff?Subscription=1',
    // '/subscription/CurrentDrivableActor.Function.HUD_GetWaterTankLevel?Subscription=1',
    // '/subscription/CurrentDrivableActor.Function.HUD_GetCoalBunkerLevel?Subscription=1',
    // '/subscription/CurrentDrivableActor.Function.HUD_GetIsSteamRequired?Subscription=1'
];

/**
 * Creates subscriptions for all endpoints in the subscriptionEndpoints array
 * Only creates subscriptions once
 */
async function createSubscriptions() {
    if (subscriptionsCreated) {
        console.log('Subscriptions already created, skipping...');
        return;
    }
    
    console.log('Creating subscriptions...');
    for (const endpoint of subscriptionEndpoints) {
        try {
            const config = {
                method: 'post',
                maxBodyLength: Infinity,
                url: `http://localhost:31270${endpoint}`,
                headers: { 
                    'DTGCommKey': apiKey
                }
            };
            const response = await axios.request(config);
            console.log(`Subscription created for ${endpoint}`);
        } catch (err) {
          console.error(`Failed to create subscription ${endpoint}:`, err.message);
        }
        
        // Wait 1/4 second between each subscription request
        await sleep(250);
    }
    subscriptionsCreated = true;
    console.log('All subscriptions created');
}

const server = http.createServer((req, res) => {
  // 1. Serve the HTML page
  if (req.url === '/') {
    fs.readFile(path.join(__dirname, 'hud.html'), (err, data) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  }
  // Serve the live map page
  else if (req.url === '/map') {
    fs.readFile(path.join(__dirname, 'live_map.html'), (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 - Map page not found</h1>');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      }
    });
  }
  // 2. The SSE Stream (The "Push" connection)
  else if (req.url === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  
  );

      console.log('Starting data stream...');
      
      // Initialize route collection start time if enabled
      if (ENABLE_ROUTE_COLLECTION && routeCollectionStartTime === null) {
        routeCollectionStartTime = Date.now();
        initializeRouteFile();
        console.log('Route collection started');
      }
      
      // Fetch and send data every 500ms
      const interval = setInterval(async () => {
        try {
          // Call Train Sim World subscription feed API
          const config = {
            method: 'get',
            maxBodyLength: Infinity,
            url: 'http://localhost:31270/subscription/?Subscription=1',
            headers: { 
              'DTGCommKey': apiKey
            }
          };
          
          const response = await axios.request(config);
          const rawData = response.data;
          
          // Parse Train Sim World API response and format for frontend
          const formattedData = {
            speed: 0,
            limit: 120,
            incline: 0,
            nextSpeedLimit: 0,
            distanceToNextSpeedLimit: 0,
            powerHandle: 0,
            direction: 0,
            isSlipping: false,
            brakeGauge1: 0,
            brakeGauge2: 0,
            acceleration: 0,
            speedControlTarget: 0,
            maxPermittedSpeed: 0,
            alerter: 0,
            ammeter: 0,
            tractiveEffort: 0,
            engineRPM: 0,
            gearIndex: 0,
            electricBrakeHandle: 0,
            electricDynamicBrake: 0,
            electricBrakeActive: false,
            locomotiveBrakeHandle: 0,
            locomotiveBrakeActive: false,
            trainBrakeHandle: 0,
            trainBreak: 0,
            trainBrakeActive: false,
            isTractionLocked: false,
            steamBoilerPressure: 0,
            steamChestPressure: 0,
            cylinderCocks: 0,
            boilerWaterLevel: 0,
            fireboxCoalLevel: 0,
            blowerFlow: 0,
            damperFlow: 0,
            reverserCutoff: 0,
            waterTankLevel: 0,
            coalBunkerLevel: 0,
            isSteamRequired: false,
            localTime: null,
            timetableTime: null,
            timetableLabel: null,
            distanceToStation: null,
            raw: rawData
          };
          
          if (rawData.Entries && rawData.Entries.length > 0) {
            for (const entry of rawData.Entries) {
              if (entry.NodeValid && entry.Values) {
                // Extract speed from HUD_GetSpeed
                if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetSpeed' && entry.Values['Speed (ms)']) {
                  // Convert m/s to km/h or mph
                  formattedData.speed = Math.round(entry.Values['Speed (ms)'] * speedConversionFactor);
                  // console.log('Fetched speed from TSW:', formattedData.speed);
                }
                // Extract power handle value
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetPowerHandle' && entry.Values['Power'] !== undefined) {
                  const powerValue = entry.Values['Power'];
                  const isNegative = entry.Values['IsNegative'];
                  // If IsNegative field exists and is true, make the value negative
                  // Otherwise, use the Power value as-is (it may already be negative)
                  // Round up using Math.ceil for positive values, Math.floor for negative values
                  const roundedValue = powerValue >= 0 ? Math.ceil(powerValue) : Math.floor(powerValue);
                  formattedData.powerHandle = (isNegative === true) ? -Math.abs(roundedValue) : roundedValue;
                }
                // Extract direction
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetDirection' && entry.Values['Direction'] !== undefined) {
                  formattedData.direction = entry.Values['Direction'];
                }
                // Extract is slipping
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetIsSlipping' && entry.Values['IsSlipping'] !== undefined) {
                  formattedData.isSlipping = entry.Values['IsSlipping'];
                }
                // Extract brake gauges
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetBrakeGauge_1' && entry.Values['BrakeGauge'] !== undefined) {
                  formattedData.brakeGauge1 = entry.Values['BrakeGauge'];
                }
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetBrakeGauge_2' && entry.Values['BrakeGauge'] !== undefined) {
                  formattedData.brakeGauge2 = entry.Values['BrakeGauge'];
                }
                // Extract acceleration
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetAcceleration' && entry.Values['Acceleration'] !== undefined) {
                  formattedData.acceleration = entry.Values['Acceleration'];
                }
                // Extract speed control target
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetSpeedControlTarget' && entry.Values['SpeedControlTarget'] !== undefined) {
                  formattedData.speedControlTarget = Math.round(entry.Values['SpeedControlTarget'] * speedConversionFactor);
                }
                // Extract max permitted speed
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetMaxPermittedSpeed' && entry.Values['MaxPermittedSpeed'] !== undefined) {
                  formattedData.maxPermittedSpeed = Math.round(entry.Values['MaxPermittedSpeed'] * speedConversionFactor);
                }
                // Extract alerter
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetAlerter' && entry.Values['Alerter'] !== undefined) {
                  formattedData.alerter = entry.Values['Alerter'];
                }
                // Extract ammeter
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetAmmeter' && entry.Values['Ammeter'] !== undefined) {
                  formattedData.ammeter = entry.Values['Ammeter'];
                }
                // Extract tractive effort
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetTractiveEffort' && entry.Values['TractiveEffort'] !== undefined) {
                  formattedData.tractiveEffort = entry.Values['TractiveEffort'];
                }
                // Extract engine RPM
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetEngineRPM' && entry.Values['EngineRPM'] !== undefined) {
                  formattedData.engineRPM = Math.round(entry.Values['EngineRPM']);
                }
                // Extract gear index
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetGearIndex' && entry.Values['GearIndex'] !== undefined) {
                  formattedData.gearIndex = entry.Values['GearIndex'];
                }
                // Extract brake handles
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetElectricBrakeHandle' && entry.Values['HandlePosition'] !== undefined) {
                  formattedData.electricBrakeHandle = entry.Values['HandlePosition'];
                  // Convert to percentage
                  formattedData.electricDynamicBrake = Math.round(entry.Values['HandlePosition'] * 100);
                  formattedData.electricBrakeActive = entry.Values['IsActive'] || false;
                }
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetLocomotiveBrakeHandle' && entry.Values['HandlePosition'] !== undefined) {
                  formattedData.locomotiveBrakeHandle = entry.Values['HandlePosition'];
                  formattedData.locomotiveBrakeActive = entry.Values['IsActive'] || false;
                }
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetTrainBrakeHandle' && entry.Values['HandlePosition'] !== undefined) {
                  formattedData.trainBrakeHandle = entry.Values['HandlePosition'];
                  formattedData.trainBreak = Math.round(entry.Values['HandlePosition'] * 100);
                  formattedData.trainBrakeActive = entry.Values['IsActive'] || false;
                }
                // Extract is traction locked
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetIsTractionLocked' && entry.Values['IsTractionLocked'] !== undefined) {
                  formattedData.isTractionLocked = entry.Values['IsTractionLocked'];
                }
                // Steam locomotive specific data
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetSteamBoilerPressure' && entry.Values['SteamBoilerPressure'] !== undefined) {
                  formattedData.steamBoilerPressure = entry.Values['SteamBoilerPressure'];
                }
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetSteamChestPressure' && entry.Values['SteamChestPressure'] !== undefined) {
                  formattedData.steamChestPressure = entry.Values['SteamChestPressure'];
                }
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetCylinderCocks' && entry.Values['CylinderCocks'] !== undefined) {
                  formattedData.cylinderCocks = entry.Values['CylinderCocks'];
                }
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetBoilerWaterLevel' && entry.Values['BoilerWaterLevel'] !== undefined) {
                  formattedData.boilerWaterLevel = entry.Values['BoilerWaterLevel'];
                }
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetFireboxCoalLevel' && entry.Values['FireboxCoalLevel'] !== undefined) {
                  formattedData.fireboxCoalLevel = entry.Values['FireboxCoalLevel'];
                }
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetBlowerFlow' && entry.Values['BlowerFlow'] !== undefined) {
                  formattedData.blowerFlow = entry.Values['BlowerFlow'];
                }
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetDamperFlow' && entry.Values['DamperFlow'] !== undefined) {
                  formattedData.damperFlow = entry.Values['DamperFlow'];
                }
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetReverserCutoff' && entry.Values['ReverserCutoff'] !== undefined) {
                  formattedData.reverserCutoff = entry.Values['ReverserCutoff'];
                }
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetWaterTankLevel' && entry.Values['WaterTankLevel'] !== undefined) {
                  formattedData.waterTankLevel = entry.Values['WaterTankLevel'];
                }
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetCoalBunkerLevel' && entry.Values['CoalBunkerLevel'] !== undefined) {
                  formattedData.coalBunkerLevel = entry.Values['CoalBunkerLevel'];
                }
                else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetIsSteamRequired' && entry.Values['IsSteamRequired'] !== undefined) {
                  formattedData.isSteamRequired = entry.Values['IsSteamRequired'];
                }
                // Extract speed limit and gradient from DriverAid.Data
                else if (entry.Path === 'DriverAid.Data') {
                  if (entry.Values['speedLimit'] && entry.Values['speedLimit']['value']) {
                    // Convert m/s to km/h or mph
                    formattedData.limit = Math.round(entry.Values['speedLimit']['value'] * speedConversionFactor);
                  }
                  if (entry.Values['gradient'] !== undefined) {
                    formattedData.incline = parseFloat(entry.Values['gradient'].toFixed(1));
                  }
                  if (entry.Values['nextSpeedLimit'] && entry.Values['nextSpeedLimit']['value']) {
                    // Convert m/s to km/h or mph
                    formattedData.nextSpeedLimit = Math.round(entry.Values['nextSpeedLimit']['value'] * speedConversionFactor);
                  }
                  if (entry.Values['distanceToNextSpeedLimit'] !== undefined) {
                    // Convert cm to meters or feet depending on unit preference
                    formattedData.distanceToNextSpeedLimit = Math.round(entry.Values['distanceToNextSpeedLimit'] / distanceConversionFactor);
                  }
                  // Store gradient for route collection
                  if (ENABLE_ROUTE_COLLECTION && typeof entry.Values['gradient'] === 'number') {
                    currentGradient = entry.Values['gradient'];
                  }
                }
                // Extract GPS coordinates from DriverAid.PlayerInfo for route collection
                else if (ENABLE_ROUTE_COLLECTION && entry.Path === 'DriverAid.PlayerInfo') {
                  if (entry.Values.geoLocation &&
                      typeof entry.Values.geoLocation.longitude === 'number' &&
                      typeof entry.Values.geoLocation.latitude === 'number') {
                    
                    const coordinate = {
                      longitude: entry.Values.geoLocation.longitude,
                      latitude: entry.Values.geoLocation.latitude
                    };

                    // Add height if available
                    if (currentHeight !== null) {
                      coordinate.height = currentHeight;
                    }

                    // Add gradient if available
                    if (currentGradient !== null) {
                      coordinate.gradient = currentGradient;
                    }

                    // Update current player position
                    currentPlayerPosition = coordinate;

                    // Only add if coordinate is different from last one
                    if (!lastRouteCoordinate ||
                        lastRouteCoordinate.longitude !== coordinate.longitude ||
                        lastRouteCoordinate.latitude !== coordinate.latitude) {
                      
                      routeCoordinates.push(coordinate);
                      lastRouteCoordinate = coordinate;
                      routeCollectionRequestCount++;

                      // Save to file immediately
                      saveRouteData();

                      // Log progress every 100 points
                      if (routeCoordinates.length % 100 === 0) {
                        console.log(`Route collection: ${routeCoordinates.length} coordinates, ${discoveredMarkers.length} markers`);
                      }
                    }
                  }
                }
                // Extract markers from DriverAid.TrackData for route collection
                else if (ENABLE_ROUTE_COLLECTION && entry.Path === 'DriverAid.TrackData' && currentPlayerPosition) {
                  // Update current height from lastPlayerPosition
                  if (entry.Values.lastPlayerPosition && typeof entry.Values.lastPlayerPosition.height === 'number') {
                    currentHeight = entry.Values.lastPlayerPosition.height;
                  }

                  // Check if we're passing over any timetable stations (distance < 1000cm = 10 meters)
                  const checkPassingStation = (markerName, distanceCM) => {
                    if (distanceCM < 1000 && markerName) {
                      // Check if this marker is in our timetable
                      const timetableStop = timetableData.find(stop => stop.apiName === markerName);
                      if (timetableStop) {
                        // Find this marker in discoveredMarkers
                        const existingMarker = discoveredMarkers.find(m => m.stationName === markerName);
                        if (existingMarker) {
                          const distanceMeters = distanceCM / 100;
                          
                          // Record/update the on-spot position (overwrite if we get closer)
                          existingMarker.onspot_latitude = currentPlayerPosition.latitude;
                          existingMarker.onspot_longitude = currentPlayerPosition.longitude;
                          existingMarker.onspot_timestamp = new Date().toISOString();
                          existingMarker.spoton_distance = distanceMeters;
                          
                          // Save to file when on-spot position recorded
                          saveRouteData();
                          
                          console.log(`Recording position for ${markerName} at ${distanceMeters.toFixed(2)}m (${currentPlayerPosition.latitude.toFixed(6)}, ${currentPlayerPosition.longitude.toFixed(6)})`);
                        }
                      }
                    }
                  };

                  // Process stations
                  if (entry.Values.stations && Array.isArray(entry.Values.stations)) {
                    for (const station of entry.Values.stations) {
                      const markerName = station.stationName || station.markerName;
                      const distanceCM = station.distanceToStationCM;
                      
                      // Check if we're passing over this station
                      checkPassingStation(markerName, distanceCM);
                      
                      if (markerName && !processedMarkers.has(markerName)) {
                        const distanceMeters = distanceCM / 100;

                        const marker = {
                          stationName: markerName,
                          markerType: station.markerType || 'Station',
                          detectedAt: {
                            longitude: currentPlayerPosition.longitude,
                            latitude: currentPlayerPosition.latitude
                          },
                          distanceAheadMeters: distanceMeters,
                          timestamp: new Date().toISOString()
                        };

                        // Add platformLength if available
                        if (typeof station.platformLength === 'number') {
                          marker.platformLength = station.platformLength;
                        }

                        discoveredMarkers.push(marker);
                        processedMarkers.add(markerName);

                        // Save to file when new marker found
                        saveRouteData();

                        console.log(`Found marker: ${markerName} (${distanceMeters.toFixed(0)}m ahead)`);
                      }
                    }
                  }

                  // Process markers
                  if (entry.Values.markers && Array.isArray(entry.Values.markers)) {
                    for (const marker of entry.Values.markers) {
                      const markerName = marker.stationName || marker.markerName;
                      const distanceCM = marker.distanceToStationCM;
                      
                      // Check if we're passing over this marker
                      checkPassingStation(markerName, distanceCM);
                      
                      if (markerName && !processedMarkers.has(markerName)) {
                        const distanceMeters = distanceCM / 100;

                        const markerObj = {
                          stationName: markerName,
                          markerType: marker.markerType || 'Marker',
                          detectedAt: {
                            longitude: currentPlayerPosition.longitude,
                            latitude: currentPlayerPosition.latitude
                          },
                          distanceAheadMeters: distanceMeters,
                          timestamp: new Date().toISOString()
                        };

                        // Add platformLength if available
                        if (typeof marker.platformLength === 'number') {
                          markerObj.platformLength = marker.platformLength;
                        }

                        discoveredMarkers.push(markerObj);
                        processedMarkers.add(markerName);

                        // Save to file when new marker found
                        saveRouteData();

                        console.log(`Found marker: ${markerName} (${distanceMeters.toFixed(0)}m ahead)`);
                      }
                    }
                  }
                }
                // Extract local time from TimeOfDay.Data
                else if (entry.Path === 'TimeOfDay.Data') {
                  if (entry.Values['LocalTimeISO8601']) {
                    formattedData.localTime = entry.Values['LocalTimeISO8601'];
                  }
                }
              }
            }
          }
          
          // Calculate timetable display based on current time
          if (formattedData.localTime) {
            const timetableDisplay = getTimetableDisplay(formattedData.localTime);
            formattedData.timetableTime = timetableDisplay.time;
            formattedData.timetableLabel = timetableDisplay.label;
            
            // Check if we have a new target station - if so, reset distance
            if (timetableDisplay.targetApiName !== lastTargetApiName) {
              lastTargetApiName = timetableDisplay.targetApiName;
              lastDistanceToStation = null; // Reset distance for new target
            }
            
            // Always try to extract distance from markers if available and we have a target
            if (rawData.Entries && timetableDisplay.targetApiName) {
              for (const entry of rawData.Entries) {
                if (entry.Path === 'DriverAid.TrackData' && entry.NodeValid && entry.Values) {
                  let foundDistance = false;
                  
                  // Check stations array first
                  if (entry.Values.stations && Array.isArray(entry.Values.stations)) {
                    for (const station of entry.Values.stations) {
                      if (station.stationName === timetableDisplay.targetApiName) {
                        // Convert cm to meters and update last known distance
                        if (typeof station.distanceToStationCM === 'number') {
                          lastDistanceToStation = Math.round(station.distanceToStationCM / 100);
                          foundDistance = true;
                        }
                        break;
                      }
                    }
                  }
                  
                  // Check markers array if not found in stations
                  if (!foundDistance && entry.Values.markers && Array.isArray(entry.Values.markers)) {
                    for (const marker of entry.Values.markers) {
                      if (marker.stationName === timetableDisplay.targetApiName) {
                        // Convert cm to meters and update last known distance
                        if (typeof marker.distanceToStationCM === 'number') {
                          lastDistanceToStation = Math.round(marker.distanceToStationCM / 100);
                        }
                        break;
                      }
                    }
                  }
                  break;
                }
              }
            }
            
            // Only set distance if we have a target station and a valid distance
            formattedData.distanceToStation = (timetableDisplay.showDistance && lastDistanceToStation !== null) ? lastDistanceToStation : null;
          }

          // SSE format requires "data: " prefix and two newlines at the end
          res.write(`data: ${JSON.stringify(formattedData)}\n\n`);
        } catch (err) {
          res.write(`data: {"error": "Failed to fetch TSW data: ${err.message}"}\n\n`);
        }
      }, 500);

      // Stop the interval if the user closes the tab
      req.on('close', () => clearInterval(interval));
  }else if (req.url === '/default.css') {
    // Handle CSS file request
    res.setHeader('Content-Type', 'text/css');
    res.statusCode = 0o100;
    res.end(fs.readFileSync('css/default.css'));
  }
});

// Delete old subscription and create new subscriptions once before starting the server
deleteSubscription().then(() => {
  // Wait 500ms after deleting subscription before creating new ones to give TSW API time to process
  return sleep(500);
}).then(() => {
  return createSubscriptions();
}).then(() => {
  const port = 3000;
  server.listen(port, '0.0.0.0', () => {
    const myIp = getInternalIpAddress();
    console.log('Server running locally at http://localhost:' + port);
    console.log('Live map available at http://localhost:' + port + '/map');
    if (myIp) {
      console.log('Server accessible on local network at http://' + myIp + ':' + port);
      console.log('Live map accessible at http://' + myIp + ':' + port + '/map');
    }
    if (ENABLE_ROUTE_COLLECTION) {
      console.log('Route collection is ENABLED - coordinates will be saved to unprocessed_routes/');
    }
  });
});

// Handle graceful shutdown and save route data
async function cleanup() {
  console.log('\n\nShutting down server...');
  
  if (ENABLE_ROUTE_COLLECTION && routeCoordinates.length > 0) {
    saveRouteData();
    console.log(`Final route saved: ${routeCoordinates.length} coordinates, ${discoveredMarkers.length} markers`);
  }
  
  process.exit(0);
}

// Listen for shutdown signals
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

})();