const fs = require('fs');
const path = require('path');

/**
 * Combines CSV timetable and JSON route data into a single JSON file
 * Usage: node combine_route.js <route_json_path> <timetable_csv_path> <output_path>
 */

// Get file paths from arguments
const routeJsonPath = process.argv[2];
const timetableCsvPath = process.argv[3];
const outputPath = process.argv[4] || 'test.json';

if (!routeJsonPath || !timetableCsvPath) {
    console.error('Usage: node combine_route.js <route_json_path> <timetable_csv_path> [output_path]');
    console.error('Example: node combine_route.js "train_routes/route_1Y08 Northampton - London Euston 0705 0044_2026-01-04_03-01-07.json" "current_timetable/1Y08 Northampton - London Euston 0705 0044.csv" "test.json"');
    process.exit(1);
}

// Check if files exist
if (!fs.existsSync(routeJsonPath)) {
    console.error(`Error: Route JSON file not found: ${routeJsonPath}`);
    process.exit(1);
}

if (!fs.existsSync(timetableCsvPath)) {
    console.error(`Error: Timetable CSV file not found: ${timetableCsvPath}`);
    process.exit(1);
}

console.log('Loading route data...');
const routeData = JSON.parse(fs.readFileSync(routeJsonPath, 'utf8'));

console.log('Loading timetable data...');
const csvContent = fs.readFileSync(timetableCsvPath, 'utf8');
const lines = csvContent.trim().split('\n');
const headers = lines[0].split(',');

// Parse CSV into timetable array
const timetable = [];
for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const stop = {
        index: i - 1,
        destination: values[0],
        arrival: values[1],
        departure: values[2],
        platform: values[3],
        apiName: values[4]
    };
    timetable.push(stop);
}

console.log(`Parsed ${timetable.length} timetable stops`);

// Create combined data structure
const combinedData = {
    ...routeData,
    timetable: timetable
};

// Write combined file
console.log(`Writing combined data to ${outputPath}...`);
fs.writeFileSync(outputPath, JSON.stringify(combinedData, null, 2));

console.log('✓ Combined route file created successfully!');
console.log(`  Route: ${routeData.routeName}`);
console.log(`  Coordinates: ${routeData.totalPoints.toLocaleString()}`);
console.log(`  Markers: ${routeData.totalMarkers}`);
console.log(`  Timetable stops: ${timetable.length}`);
console.log(`  Output: ${outputPath}`);
