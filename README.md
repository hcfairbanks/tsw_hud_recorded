# tsw_timetable_extractor
Extracts tsw game timetables using screen shots

## Running the Application

```bash
node extract.js
node extract.js 2
node extract.js 3 "Destination Name"
node extract.js 4 "Service Name - *First Stop* to Last Stop 0000 0000"
```

## Route Recording & Processing

### Recording a Route
The server automatically records route data when `ENABLE_ROUTE_COLLECTION` is enabled in the configuration. Route files are saved to `train_routes/` directory.

```bash
# Start the recording server
node server.js
```

### Live Route Playback
Play back a recorded route with live train tracking:

```bash
# Run the route playback server (loads the most recent route matching your timetable)
node run_route.js
```

The playback server:
- Loads the pre-recorded route JSON file matching your current timetable
- Displays the route, all markers, and start/end points on a map
- Shows your live train position as you drive
- Calculates and displays accurate distance to next timetable station along the route
- Updates in real-time as you progress through the route

Access the live tracker at `http://localhost:3000`

### Post-Trip Processing
After recording a trip, process the route file to calculate accurate marker positions:

```bash
# Process a single route file
node process_trip.js "train_routes/route_1Y08 Northampton - London Euston 0705 0044_2026-01-04_03-01-07.json"

# Process with different output file
node process_trip.js input.json output.json

# Process all route files in train_routes/
node process_trip.js --all

# Force reprocess already processed files
node process_trip.js --all --force
```

The script calculates `latitude` and `longitude` for each marker using:
1. **Method 1 (Preferred):** `onspot_latitude`, `onspot_longitude`, and `spoton_distance`
2. **Method 2 (Fallback):** `detectedAt` position and `distanceAheadMeters`

Each marker will receive:
- `latitude`: Calculated latitude position
- `longitude`: Calculated longitude position
- `calculationMethod`: Method used (`onspot`, `detectedAt`, or `error`)

### Viewing Routes
Open `view_route.html` in a web browser to visualize processed routes:

1. Open `view_route.html` in your browser
2. Click "Choose File" and select a route JSON file
3. The map displays:
   - Complete route path (blue line)
   - Start point (green marker)
   - End point (red marker)
   - Stations (red circle markers)
   - Other markers (cyan circle markers)
4. Click markers for detailed information
5. Use toggles to show/hide different elements

## Running Tests

```bash
# Run all tests
node tests/run_tests.js

# Run tests for a specific timetable
node tests/run_tests.js 201D-02
node tests/run_tests.js 221D-15
node tests/run_tests.js 2N04
node tests/run_tests.js 2Y09
node tests/run_tests.js 741-06
```

## Generate Expected Test Results

```bash
node tests/generate_expected.js <test_id>
```
