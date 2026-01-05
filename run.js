'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { networkInterfaces } = require('os');

// Route configuration - no route loaded at startup
let routeFilePath = null;
let loadedRouteData = null;

console.log('Server starting - waiting for user to select a route file...');

// Read the API key from the specified file
const windows_users_folder = process.env.USERPROFILE || 'DefaultUser';
const apiKeyPath = path.join(windows_users_folder, 'Documents', 'My Games', 'TrainSimWorld6', 'Saved', 'Config', 'CommAPIKey.txt');

// Set to true for miles, false for kilometers
const useMiles = false;

// Player tracking
let currentPlayerPosition = null;

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
 * Loads and parses the timetable data from the route file
 */
function loadTimetable() {
    try {
        // Use embedded timetable from route data
        if (loadedRouteData && loadedRouteData.timetable && Array.isArray(loadedRouteData.timetable) && loadedRouteData.timetable.length > 0) {
            timetableData = loadedRouteData.timetable;
            console.log(`✓ Using embedded timetable: ${timetableData.length} stops`);
            console.log(`  First stop: ${timetableData[0].destination} - Departure: ${timetableData[0].departure} (${timetableData[0].apiName})`);
            return;
        }
        
        console.warn('⚠ No timetable data found in route file');
        timetableData = [];
    } catch (err) {
        console.error('Failed to load timetable:', err.message);
        timetableData = [];
    }
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
        
        // Debug logging
        if (!getTimetableDisplay.logged) {
            console.log(`[Timetable] Current time: ${timePart} (${currentSeconds}s)`);
            console.log(`[Timetable] First stop: ${timetableData[0].destination} - Departure: ${timetableData[0].departure}`);
            getTimetableDisplay.logged = true;
        }
        
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

// Timetable will be loaded when user selects a route

/**
 * Calculate distance between two lat/lng points using Haversine formula
 * Returns distance in meters
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

/**
 * Find nearest coordinate index on route to given position
 */
function findNearestRouteIndex(lat, lon) {
    if (!loadedRouteData || !loadedRouteData.coordinates) {
        return -1;
    }

    let minDistance = Infinity;
    let nearestIndex = 0;

    for (let i = 0; i < loadedRouteData.coordinates.length; i++) {
        const coord = loadedRouteData.coordinates[i];
        const distance = calculateDistance(lat, lon, coord.latitude, coord.longitude);
        
        if (distance < minDistance) {
            minDistance = distance;
            nearestIndex = i;
        }
    }

    return nearestIndex;
}

/**
 * Calculate distance along route from player to marker
 */
function calculateDistanceAlongRoute(playerLat, playerLon, markerLat, markerLon) {
    if (!loadedRouteData || !loadedRouteData.coordinates) {
        return null;
    }

    // Find player's position on route
    const playerIndex = findNearestRouteIndex(playerLat, playerLon);
    
    // Find marker's position on route
    const markerIndex = findNearestRouteIndex(markerLat, markerLon);
    
    if (playerIndex === -1 || markerIndex === -1) {
        return null;
    }

    // If marker is behind player, return null
    if (markerIndex <= playerIndex) {
        return 0;
    }

    // Calculate cumulative distance along route
    let totalDistance = 0;
    for (let i = playerIndex; i < markerIndex; i++) {
        const coord1 = loadedRouteData.coordinates[i];
        const coord2 = loadedRouteData.coordinates[i + 1];
        totalDistance += calculateDistance(
            coord1.latitude,
            coord1.longitude,
            coord2.latitude,
            coord2.longitude
        );
    }

    return totalDistance;
}

/**
 * Get next timetable marker based on current target
 */
function getNextTimetableMarker(targetApiName) {
    if (!targetApiName || !loadedRouteData || !loadedRouteData.markers) {
        return null;
    }

    // Find marker matching the target API name
    const marker = loadedRouteData.markers.find(m => m.stationName === targetApiName);
    
    if (!marker) {
        return null;
    }

    // Return marker with calculated position (lat/lng)
    return {
        name: marker.stationName,
        latitude: marker.latitude || marker.detectedAt?.latitude,
        longitude: marker.longitude || marker.detectedAt?.longitude,
        type: marker.markerType
    };
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
  // Serve the HUD page at root
  if (req.url === '/') {
    fs.readFile(path.join(__dirname, 'hud.html'), (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 - hud.html not found</h1>');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      }
    });
  }
  // Serve the route map viewer at /map
  else if (req.url === '/map') {
    fs.readFile(path.join(__dirname, 'live_route.html'), (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 - live_route.html not found</h1>');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      }
    });
  }
  // Serve route data
  else if (req.url === '/route-data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!loadedRouteData) {
      res.end(JSON.stringify({ error: 'No route loaded. Please select a route file.' }));
      return;
    }
    const routeDataWithTimetable = {
      ...loadedRouteData,
      timetableStations: timetableData.map(stop => stop.station),
      currentRouteFile: routeFilePath ? path.basename(routeFilePath) : 'unknown'
    };
    res.end(JSON.stringify(routeDataWithTimetable));
  }
  // API endpoint to list available processed routes
  else if (req.url === '/api/routes') {
    try {
      const processedRoutesDir = path.join(__dirname, 'processed_routes');
      const unprocessedRoutesDir = path.join(__dirname, 'unprocessed_routes');
      
      const routes = {
        processed: [],
        unprocessed: []
      };
      
      // Get processed routes
      if (fs.existsSync(processedRoutesDir)) {
        routes.processed = fs.readdirSync(processedRoutesDir)
          .filter(f => f.startsWith('route_') && f.endsWith('.json'))
          .map(filename => ({
            filename: filename,
            name: filename.replace('route_', '').replace('.json', ''),
            type: 'processed'
          }));
      }
      
      // Get unprocessed routes
      if (fs.existsSync(unprocessedRoutesDir)) {
        routes.unprocessed = fs.readdirSync(unprocessedRoutesDir)
          .filter(f => f.startsWith('route_') && f.endsWith('.json'))
          .map(filename => ({
            filename: filename,
            name: filename.replace('route_', '').replace('.json', ''),
            type: 'unprocessed'
          }));
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(routes));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
  // API endpoint to browse directories
  else if (req.url.startsWith('/api/browse?')) {
    try {
      const urlParams = new URLSearchParams(req.url.split('?')[1]);
      const requestedPath = urlParams.get('path') || '';
      
      // Start from workspace root
      let browsePath;
      if (!requestedPath) {
        browsePath = __dirname;
      } else {
        // Resolve relative to workspace root
        browsePath = path.join(__dirname, requestedPath);
        // Security check - ensure path is within workspace
        if (!browsePath.startsWith(__dirname)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Access denied' }));
          return;
        }
      }
      
      if (!fs.existsSync(browsePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Path not found' }));
        return;
      }
      
      const stats = fs.statSync(browsePath);
      if (!stats.isDirectory()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Path is not a directory' }));
        return;
      }
      
      const items = fs.readdirSync(browsePath).map(item => {
        const fullPath = path.join(browsePath, item);
        const itemStats = fs.statSync(fullPath);
        const relativePath = path.relative(__dirname, fullPath);
        
        return {
          name: item,
          path: relativePath.replace(/\\/g, '/'),
          isDirectory: itemStats.isDirectory(),
          isRoute: !itemStats.isDirectory() && item.endsWith('.json') && item.startsWith('route_')
        };
      }).sort((a, b) => {
        // Directories first, then files
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });
      
      // Get parent path
      const parentPath = requestedPath ? path.dirname(requestedPath).replace(/\\/g, '/') : null;
      const currentPath = requestedPath.replace(/\\/g, '/');
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        currentPath: currentPath || '.',
        parentPath: parentPath === '.' ? null : parentPath,
        items: items
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
  // API endpoint to load a specific route
  else if (req.url.startsWith('/api/load-route?')) {
    try {
      const urlParams = new URLSearchParams(req.url.split('?')[1]);
      const filename = urlParams.get('file');
      const type = urlParams.get('type') || 'processed';
      const filePath = urlParams.get('path'); // New parameter for full path
      
      let newRoutePath;
      
      if (filePath) {
        // Use provided path (from folder browser)
        newRoutePath = path.join(__dirname, filePath);
        // Security check
        if (!newRoutePath.startsWith(__dirname)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Access denied' }));
          return;
        }
      } else if (filename) {
        // Use old method (from dropdown)
        const routesDir = type === 'processed' 
          ? path.join(__dirname, 'processed_routes')
          : path.join(__dirname, 'unprocessed_routes');
        newRoutePath = path.join(routesDir, filename);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing filename or path parameter' }));
        return;
      }
      
      if (!fs.existsSync(newRoutePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Route file not found' }));
        return;
      }
      
      // Load the new route
      const newRouteData = JSON.parse(fs.readFileSync(newRoutePath, 'utf8'));
      
      // Update global variables
      loadedRouteData = newRouteData;
      routeFilePath = newRoutePath;
      
      // Reload timetable if embedded in route
      if (newRouteData.timetable) {
        timetableData = newRouteData.timetable;
        console.log(`Switched to route: ${path.basename(newRoutePath)}`);
        console.log(`Loaded ${timetableData.length} stops from route file`);
      } else {
        timetableData = [];
        console.log(`Switched to route: ${path.basename(newRoutePath)} (no timetable)`);
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        message: `Loaded ${path.basename(newRoutePath)}`,
        routeName: newRouteData.routeName,
        totalPoints: newRouteData.totalPoints,
        totalMarkers: newRouteData.totalMarkers
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
  // API endpoint to upload route data from client
  else if (req.url === '/api/upload-route' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const { filename, routeData } = JSON.parse(body);
        
        if (!routeData || !routeData.coordinates || !routeData.routeName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid route data' }));
          return;
        }
        
        // Update global variables with uploaded route
        loadedRouteData = routeData;
        routeFilePath = filename;
        
        // Load timetable if embedded in route
        if (routeData.timetable) {
          timetableData = routeData.timetable;
          console.log(`✓ User loaded route: ${filename}`);
          console.log(`  Route: ${routeData.routeName}`);
          console.log(`  Coordinates: ${routeData.totalPoints}`);
          console.log(`  Markers: ${routeData.totalMarkers}`);
          console.log(`  Timetable: ${timetableData.length} stops`);
        } else {
          timetableData = [];
          console.log(`✓ User loaded route: ${filename} (no timetable)`);
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: `Loaded ${filename}`,
          routeName: routeData.routeName,
          totalPoints: routeData.totalPoints,
          totalMarkers: routeData.totalMarkers
        }));
      } catch (err) {
        console.error('Failed to upload route:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }
  // The SSE Stream for live position updates
  else if (req.url === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    console.log('Starting live position stream...');
    
    // Fetch and send position data every 500ms
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
        
        // Parse for position and timetable data
        const streamData = {
          playerPosition: null,
          localTime: null,
          timetableTime: null,
          timetableLabel: null,
          distanceToStation: null,
          speed: 0,
          direction: 0,
          limit: 0,
          isSlipping: false,
          powerHandle: 0,
          incline: 0,
          nextSpeedLimit: 0,
          distanceToNextSpeedLimit: 0,
          trainBreak: 0,
          trainBrakeActive: false,
          locomotiveBrakeHandle: 0,
          locomotiveBrakeActive: false,
          electricDynamicBrake: 0,
          electricBrakeActive: false,
          isTractionLocked: false
        };
        
        if (rawData.Entries && rawData.Entries.length > 0) {
          for (const entry of rawData.Entries) {
            if (entry.NodeValid && entry.Values) {
              // Extract GPS coordinates from DriverAid.PlayerInfo
              if (entry.Path === 'DriverAid.PlayerInfo') {
                if (entry.Values.geoLocation &&
                    typeof entry.Values.geoLocation.longitude === 'number' &&
                    typeof entry.Values.geoLocation.latitude === 'number') {
                  
                  currentPlayerPosition = {
                    longitude: entry.Values.geoLocation.longitude,
                    latitude: entry.Values.geoLocation.latitude
                  };
                  
                  streamData.playerPosition = currentPlayerPosition;
                }
              }
              // Extract speed
              else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetSpeed' && entry.Values['Speed (ms)']) {
                streamData.speed = Math.round(entry.Values['Speed (ms)'] * speedConversionFactor);
              }
              // Extract direction
              else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetDirection' && entry.Values['Direction'] !== undefined) {
                streamData.direction = entry.Values['Direction'];
              }
              // Extract power handle
              else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetPowerHandle' && entry.Values['Power'] !== undefined) {
                const powerValue = entry.Values['Power'];
                const isNegative = entry.Values['IsNegative'];
                const roundedValue = powerValue >= 0 ? Math.ceil(powerValue) : Math.floor(powerValue);
                streamData.powerHandle = (isNegative === true) ? -Math.abs(roundedValue) : roundedValue;
              }
              // Extract is slipping
              else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetIsSlipping' && entry.Values['IsSlipping'] !== undefined) {
                streamData.isSlipping = entry.Values['IsSlipping'];
              }
              // Extract train brake (gauge 1)
              else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetTrainBrakeHandle' && entry.Values['HandlePosition'] !== undefined) {
                streamData.trainBreak = Math.round(entry.Values['HandlePosition'] * 100);
                streamData.trainBrakeActive = entry.Values['IsActive'] || false;
              }
              // Extract locomotive brake
              else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetLocomotiveBrakeHandle' && entry.Values['HandlePosition'] !== undefined) {
                streamData.locomotiveBrakeHandle = entry.Values['HandlePosition'];
                streamData.locomotiveBrakeActive = entry.Values['IsActive'] || false;
              }
              // Extract electric brake
              else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetElectricBrakeHandle' && entry.Values['HandlePosition'] !== undefined) {
                streamData.electricDynamicBrake = Math.round(entry.Values['HandlePosition'] * 100);
                streamData.electricBrakeActive = entry.Values['IsActive'] || false;
              }
              // Extract traction locked
              else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetIsTractionLocked' && entry.Values['IsTractionLocked'] !== undefined) {
                streamData.isTractionLocked = entry.Values['IsTractionLocked'];
              }
              // Extract speed limit
              else if (entry.Path === 'CurrentDrivableActor.Function.HUD_GetMaxPermittedSpeed' && entry.Values['MaxPermittedSpeed'] !== undefined) {
                streamData.maxPermittedSpeed = Math.round(entry.Values['MaxPermittedSpeed'] * speedConversionFactor);
              }
              // Extract speed limit and gradient from DriverAid.Data
              else if (entry.Path === 'DriverAid.Data') {
                if (entry.Values['speedLimit'] && entry.Values['speedLimit']['value']) {
                  streamData.limit = Math.round(entry.Values['speedLimit']['value'] * speedConversionFactor);
                }
                if (entry.Values['gradient'] !== undefined) {
                  streamData.incline = parseFloat(entry.Values['gradient'].toFixed(1));
                }
                if (entry.Values['nextSpeedLimit'] && entry.Values['nextSpeedLimit']['value']) {
                  streamData.nextSpeedLimit = Math.round(entry.Values['nextSpeedLimit']['value'] * speedConversionFactor);
                }
                if (entry.Values['distanceToNextSpeedLimit'] !== undefined) {
                  streamData.distanceToNextSpeedLimit = Math.round(entry.Values['distanceToNextSpeedLimit'] / distanceConversionFactor);
                }
              }
              // Extract local time
              else if (entry.Path === 'TimeOfDay.Data') {
                if (entry.Values['LocalTimeISO8601']) {
                  streamData.localTime = entry.Values['LocalTimeISO8601'];
                }
              }
            }
          }
        }
        
        // Calculate timetable display and distance
        if (streamData.localTime) {
          const timetableDisplay = getTimetableDisplay(streamData.localTime);
          streamData.timetableTime = timetableDisplay.time;
          streamData.timetableLabel = timetableDisplay.label;
          
          // Calculate distance along route to next marker
          if (timetableDisplay.targetApiName && currentPlayerPosition) {
            const nextMarker = getNextTimetableMarker(timetableDisplay.targetApiName);
            
            if (nextMarker && nextMarker.latitude && nextMarker.longitude) {
              // EXPERIMENT: Using straight-line distance instead of track distance
              const distance = calculateDistanceAlongRoute(
              //const distance = calculateDistance(
                currentPlayerPosition.latitude,
                currentPlayerPosition.longitude,
                nextMarker.latitude,
                nextMarker.longitude
              );
              
              if (distance !== null) {
                streamData.distanceToStation = Math.round(distance);
              }
            }
          }
        }

        // Send data to frontend
        res.write(`data: ${JSON.stringify(streamData)}\n\n`);
      } catch (err) {
        res.write(`data: {"error": "Failed to fetch TSW data: ${err.message}"}\n\n`);
      }
    }, 500);

    // Stop the interval if the user closes the tab
    req.on('close', () => clearInterval(interval));
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
    console.log('###############################################################');
    console.log('#          Route Playback Server - Live Tracking             #');
    console.log('###############################################################');
    console.log('\nNo route loaded - waiting for user selection');
    console.log(`\nServer running at:`);
    console.log(`  Local:   http://localhost:${port}`);
    if (myIp) {
      console.log(`  Network: http://${myIp}:${port}`);
    }
    console.log('\nGo to http://localhost:${port}/map and select a route file\n');
  });
});

// Handle graceful shutdown
async function cleanup() {
  console.log('\n\nShutting down server...');
  process.exit(0);
}

// Listen for shutdown signals
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

})();
