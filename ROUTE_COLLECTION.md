# Route Collection Feature

## Overview
The HUD server now automatically collects GPS coordinates (latitude/longitude) and track markers while running. This allows you to map out the route you drive in Train Sim World.

## Configuration
At the top of [server.js](server.js), you can configure:

```javascript
const ENABLE_ROUTE_COLLECTION = true; // Set to false to disable route collection
const ROUTE_COLLECTION_INTERVAL = 125; // ms between GPS coordinate collections
```

## How It Works
When route collection is enabled:

1. **Automatic Collection**: As soon as a client connects to the stream, the server starts collecting GPS coordinates
2. **Coordinate Tracking**: Every time your position changes, the server records:
   - Latitude and longitude
   - Height (elevation)
   - Gradient (slope)
3. **Marker Detection**: The server automatically detects and records:
   - Stations
   - Speed limit signs
   - Other track markers
   - Distance from detection point

## Output
When you shut down the server (Ctrl+C), the collected data is automatically saved to:

```
route_output/route_<timetable_name>_<timestamp>.json
```

### Output Format
```json
{
  "routeName": "1Y08 Northampton - London Euston 0705 0044",
  "totalPoints": 1523,
  "totalMarkers": 15,
  "startTime": "2026-01-03T12:30:00.000Z",
  "endTime": "2026-01-03T13:45:00.000Z",
  "duration": 4500000,
  "requestCount": 36000,
  "coordinates": [
    {
      "longitude": -0.77392,
      "latitude": 52.03387,
      "height": 45.2,
      "gradient": 0.5
    }
  ],
  "markers": [
    {
      "stationName": "Milton Keynes Central",
      "markerType": "Station",
      "detectedAt": {
        "longitude": -0.77392,
        "latitude": 52.03387
      },
      "distanceAheadMeters": 1250,
      "timestamp": "2026-01-03T12:35:00.000Z",
      "platformLength": 220
    }
  ]
}
```

## Usage Tips
- The route collection runs in the background and doesn't affect HUD performance
- Progress is logged to console every 100 coordinates collected
- All marker discoveries are logged in real-time
- Data is automatically saved when you stop the server with Ctrl+C
- Set `ENABLE_ROUTE_COLLECTION = false` if you don't want to collect route data

## Further Processing
You can use the output JSON files with tools like the `tsw_rail_line_mapper` project to:
- Visualize routes on a map
- Calculate precise marker positions
- Analyze route characteristics
- Generate route documentation
