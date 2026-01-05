const fs = require('fs');
const path = require('path');

/**
 * Calculate distance between two lat/lng points using Haversine formula
 * Returns distance in meters
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

/**
 * Follow the route path from a starting coordinate index for a specified distance
 * Returns {latitude, longitude} of the point on the route that is distance meters ahead
 */
function followRoutePath(coordinates, startIndex, distanceMeters) {
    if (startIndex >= coordinates.length - 1) {
        // Already at or past the end
        const lastCoord = coordinates[coordinates.length - 1];
        return {
            latitude: lastCoord.latitude,
            longitude: lastCoord.longitude
        };
    }

    let remainingDistance = distanceMeters;
    let currentIndex = startIndex;

    // Walk along the route, accumulating distance
    while (currentIndex < coordinates.length - 1 && remainingDistance > 0) {
        const current = coordinates[currentIndex];
        const next = coordinates[currentIndex + 1];

        const segmentDistance = calculateDistance(
            current.latitude,
            current.longitude,
            next.latitude,
            next.longitude
        );

        if (segmentDistance >= remainingDistance) {
            // The target point is within this segment
            // Interpolate between current and next
            const ratio = remainingDistance / segmentDistance;
            return {
                latitude: current.latitude + (next.latitude - current.latitude) * ratio,
                longitude: current.longitude + (next.longitude - current.longitude) * ratio
            };
        }

        // Move to next segment
        remainingDistance -= segmentDistance;
        currentIndex++;
    }

    // Reached the end of the route
    const lastCoord = coordinates[coordinates.length - 1];
    return {
        latitude: lastCoord.latitude,
        longitude: lastCoord.longitude
    };
}

/**
 * Find the nearest route coordinate to a given position
 * Returns the index of the nearest coordinate
 */
function findNearestCoordinateIndex(coordinates, targetLat, targetLon) {
    let minDistance = Infinity;
    let nearestIndex = 0;

    for (let i = 0; i < coordinates.length; i++) {
        const coord = coordinates[i];
        const distance = calculateDistance(
            targetLat,
            targetLon,
            coord.latitude,
            coord.longitude
        );

        if (distance < minDistance) {
            minDistance = distance;
            nearestIndex = i;
        }
    }

    return nearestIndex;
}

/**
 * Load timetable CSV and return both the API names list and full timetable data
 */
function loadTimetableStations(routeName) {
    try {
        const currentTimetableDir = path.join(__dirname, 'save', 'current_timetable');
        const timetableFiles = fs.readdirSync(currentTimetableDir).filter(file => file.endsWith('.csv'));
        
        if (timetableFiles.length === 0) {
            console.warn('⚠ No timetable file found');
            return { apiNames: [], timetableData: [] };
        }
        
        const timetablePath = path.join(currentTimetableDir, timetableFiles[0]);
        const csvContent = fs.readFileSync(timetablePath, 'utf8');
        const lines = csvContent.trim().split('\n');
        const apiNames = [];
        const timetableData = [];
        
        // Skip header row
        for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].split(',');
            if (parts.length >= 5) {
                const apiName = parts[4].trim();
                if (apiName) {
                    apiNames.push(apiName);
                }
                
                // Build timetable entry
                timetableData.push({
                    index: i - 1,
                    destination: parts[0],
                    arrival: parts[1],
                    departure: parts[2],
                    platform: parts[3],
                    apiName: apiName
                });
            }
        }
        
        console.log(`Loaded ${apiNames.length} timetable station API names: ${apiNames.join(', ')}`);
        return { apiNames, timetableData };
    } catch (err) {
        console.warn('⚠ Failed to load timetable:', err.message);
        return { apiNames: [], timetableData: [] };
    }
}

/**
 * Process markers and calculate their actual positions
 * Method 1: Use onspot_latitude/onspot_longitude and spoton_distance
 * Method 2: Use detectedAt position and distanceAheadMeters
 */
function processMarkers(data, timetableStations) {
    if (!data.coordinates || !Array.isArray(data.coordinates) || data.coordinates.length === 0) {
        throw new Error('Invalid route data: missing or empty coordinates array');
    }

    if (!data.markers || !Array.isArray(data.markers)) {
        console.log('No markers to process');
        return 0;
    }

    console.log(`\nProcessing ${data.markers.length} markers...`);
    let method1Count = 0;
    let method2Count = 0;
    let errorCount = 0;

    for (let i = 0; i < data.markers.length; i++) {
        const marker = data.markers[i];
        const markerName = marker.stationName || marker.markerName || `Marker ${i + 1}`;
        
        // Check if this marker is a timetable station
        // The marker's stationName should match the timetable's apiName exactly
        marker.isTimetableStation = timetableStations.includes(marker.stationName);

        try {
            // Method 1: Use onspot position and spoton_distance
            if (marker.onspot_latitude && marker.onspot_longitude && marker.spoton_distance !== undefined) {
                // Find the nearest coordinate to the onspot position
                const nearestIndex = findNearestCoordinateIndex(
                    data.coordinates,
                    marker.onspot_latitude,
                    marker.onspot_longitude
                );

                // Follow the route path from this point for spoton_distance meters
                const position = followRoutePath(
                    data.coordinates,
                    nearestIndex,
                    marker.spoton_distance
                );

                marker.latitude = position.latitude;
                marker.longitude = position.longitude;
                marker.calculationMethod = 'onspot';
                
                method1Count++;
                console.log(`  ✓ ${markerName}: Using onspot position (${marker.spoton_distance.toFixed(2)}m ahead)`);
            }
            // Method 2: Use detectedAt position and distanceAheadMeters
            else if (marker.detectedAt && marker.detectedAt.latitude && marker.detectedAt.longitude && marker.distanceAheadMeters !== undefined) {
                // Find the nearest coordinate to the detected position
                const nearestIndex = findNearestCoordinateIndex(
                    data.coordinates,
                    marker.detectedAt.latitude,
                    marker.detectedAt.longitude
                );

                // Follow the route path from this point for distanceAheadMeters
                const position = followRoutePath(
                    data.coordinates,
                    nearestIndex,
                    marker.distanceAheadMeters
                );

                marker.latitude = position.latitude;
                marker.longitude = position.longitude;
                marker.calculationMethod = 'detectedAt';
                
                method2Count++;
                console.log(`  ✓ ${markerName}: Using detectedAt position (${marker.distanceAheadMeters.toFixed(2)}m ahead)`);
            }
            else {
                // No valid data to calculate position
                console.warn(`  ⚠ ${markerName}: Missing required position data, skipping`);
                marker.calculationMethod = 'none';
                errorCount++;
            }
        } catch (error) {
            console.error(`  ✗ ${markerName}: Error - ${error.message}`);
            marker.calculationMethod = 'error';
            errorCount++;
        }
        
        // Clean up unnecessary fields
        delete marker.detectedAt;
        delete marker.distanceAheadMeters;
        delete marker.timestamp;
        delete marker.platformLength;
        delete marker.calculationMethod;
        delete marker.onspot_latitude;
        delete marker.onspot_longitude;
        delete marker.onspot_timestamp;
        delete marker.spoton_distance;
    }

    console.log(`\nProcessing Summary:`);
    console.log(`  Method 1 (onspot): ${method1Count} markers`);
    console.log(`  Method 2 (detectedAt): ${method2Count} markers`);
    console.log(`  Errors/Skipped: ${errorCount} markers`);

    return method1Count + method2Count;
}

/**
 * Process a single route file
 */
function processRouteFile(inputPath, outputPath) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing: ${path.basename(inputPath)}`);
    console.log('='.repeat(60));

    // Read input file
    console.log('Reading file...');
    const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

    // Check if --force flag is present
    const forceReprocess = process.argv.includes('--force');

    // Validate data
    if (!data.routeName) {
        console.warn('Warning: No route name found');
    }
    
    console.log(`Route: ${data.routeName || 'Unknown'}`);
    console.log(`Total coordinates: ${data.coordinates ? data.coordinates.length.toLocaleString() : 0}`);
    console.log(`Total markers: ${data.markers ? data.markers.length : 0}`);

    // Use embedded timetable data if available, otherwise load from CSV
    let timetableStations = [];
    let timetableData = [];
    
    if (data.timetable && Array.isArray(data.timetable) && data.timetable.length > 0) {
        console.log(`Using embedded timetable data (${data.timetable.length} stops)`);
        timetableData = data.timetable;
        timetableStations = data.timetable.map(stop => stop.apiName).filter(name => name);
    } else {
        console.log('No embedded timetable, attempting to load from CSV...');
        const result = loadTimetableStations(data.routeName);
        timetableStations = result.apiNames;
        timetableData = result.timetableData;
    }

    // Process markers
    const processedCount = processMarkers(data, timetableStations);

    // Add timetable data to output (even if no markers were processed)
    if (timetableData.length > 0) {
        data.timetable = timetableData;
        console.log(`\n✓ Added timetable data: ${timetableData.length} stops`);
    }

    if (processedCount === 0) {
        console.log('\nNo markers were processed');
        // Still save if we added timetable data
        if (timetableData.length === 0) {
            return false;
        }
    }

    // Clean up processing metadata fields from data object
    delete data.markersProcessed;
    delete data.markersProcessedTimestamp;
    delete data.processingVersion;

    // Write output file
    console.log(`\nWriting output to: ${path.basename(outputPath)}`);
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
    console.log('✓ File saved successfully');

    return true;
}

/**
 * Main function
 */
function main() {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║     Post-Trip Processing Script - Marker Calculator      ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');

    const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
    const flags = process.argv.slice(2).filter(arg => arg.startsWith('--'));

    if (args.length === 0) {
        console.log('\nUsage: node process_trip.js <input_file> [output_file] [--force]');
        console.log('       node process_trip.js --all [--force]');
        console.log('\nDescription:');
        console.log('  Calculates latitude and longitude for each marker using:');
        console.log('  1. onspot_latitude/longitude + spoton_distance (preferred)');
        console.log('  2. detectedAt position + distanceAheadMeters (fallback)');
        console.log('\nExamples:');
        console.log('  node process_trip.js unprocessed_routes/route_1Y08.json');
        console.log('  node process_trip.js unprocessed_routes/route_1Y08.json processed_routes/route_1Y08.json');
        console.log('  node process_trip.js --all');
        console.log('  node process_trip.js unprocessed_routes/route_1Y08.json --force');
        console.log('\nFlags:');
        console.log('  --all    Process all route files in unprocessed_routes/ directory');
        console.log('  --force  Reprocess files that have already been processed');
        return;
    }

    if (args[0] === '--all' || flags.includes('--all')) {
        // Process all route files in unprocessed_routes directory
        const routesDir = path.join(__dirname, 'unprocessed_routes');
        
        if (!fs.existsSync(routesDir)) {
            console.error(`\nError: Directory not found: ${routesDir}`);
            console.log('Please create the unprocessed_routes directory or specify a file.');
            return;
        }

        const files = fs.readdirSync(routesDir)
            .filter(f => f.startsWith('route_') && f.endsWith('.json'));

        if (files.length === 0) {
            console.log(`\nNo route files found in unprocessed_routes/`);
            return;
        }

        console.log(`\nFound ${files.length} route file(s) to process\n`);

        // Create processed_routes directory if it doesn't exist
        const processedDir = path.join(__dirname, 'processed_routes');
        if (!fs.existsSync(processedDir)) {
            fs.mkdirSync(processedDir, { recursive: true });
            console.log('Created processed_routes directory\n');
        }

        let processedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (const file of files) {
            const inputPath = path.join(routesDir, file);
            const outputPath = path.join(processedDir, file);

            try {
                const result = processRouteFile(inputPath, outputPath);
                if (result === true) {
                    processedCount++;
                } else if (result === false) {
                    skippedCount++;
                }
            } catch (error) {
                console.error(`\n✗ Error processing ${file}:`);
                console.error(`  ${error.message}`);
                errorCount++;
            }
        }

        console.log('\n' + '='.repeat(60));
        console.log('FINAL SUMMARY');
        console.log('='.repeat(60));
        console.log(`✓ Processed: ${processedCount} file(s)`);
        console.log(`⊘ Skipped:   ${skippedCount} file(s)`);
        console.log(`✗ Errors:    ${errorCount} file(s)`);
        console.log('='.repeat(60) + '\n');
    } else {
        // Process single file
        const inputPath = args[0];
        
        // Determine output path
        let outputPath;
        if (args[1]) {
            // User specified output path
            outputPath = args[1];
        } else {
            // Default: save to processed_routes folder with same filename
            const processedDir = path.join(__dirname, 'processed_routes');
            
            // Create processed_routes directory if it doesn't exist
            if (!fs.existsSync(processedDir)) {
                fs.mkdirSync(processedDir, { recursive: true });
                console.log('Created processed_routes directory');
            }
            
            const filename = path.basename(inputPath);
            outputPath = path.join(processedDir, filename);
        }

        if (!fs.existsSync(inputPath)) {
            console.error(`\nError: File not found: ${inputPath}`);
            return;
        }

        try {
            processRouteFile(inputPath, outputPath);
            console.log('\n✓ Processing completed successfully\n');
        } catch (error) {
            console.error(`\n✗ Error: ${error.message}\n`);
            process.exit(1);
        }
    }
}

// Run main function
main();
