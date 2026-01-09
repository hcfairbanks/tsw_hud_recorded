const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const IMAGE_DIR = './timetable_images';
const OUTPUT_TXT = './timetable_formatted.txt';
const OUTPUT_CSV_DIR = './formats/csv';
const OUTPUT_THIRDRAILS_DIR = './formats/thirdrails';
const OUTPUT_UNPROCESSED_DIR = './unprocessed_routes';
const STATION_NAMES_DIR = './station_names';

// Load station name mappings
function loadStationNameMappings() {
  const mappings = new Map();
  try {
    const stationNamesPath = path.join(__dirname, STATION_NAMES_DIR);
    if (fs.existsSync(stationNamesPath)) {
      const files = fs.readdirSync(stationNamesPath).filter(file => file.endsWith('.json'));
      files.forEach(file => {
        try {
          const filePath = path.join(stationNamesPath, file);
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          // Add all mappings from this file
          Object.entries(data).forEach(([key, value]) => {
            mappings.set(key, value);
          });
          console.log(`Loaded station mappings from ${file}`);
        } catch (err) {
          console.warn(`Failed to load station mappings from ${file}:`, err.message);
        }
      });
    }
  } catch (err) {
    console.warn('Failed to load station name mappings:', err.message);
  }
  return mappings;
}

// Get mapped station name or return original
function getMappedStationName(stationMappings, destinationName) {
  return stationMappings.get(destinationName) || destinationName;
}

// Load mappings at startup
const stationMappings = loadStationNameMappings();

/**
 * Detect and split image into green section (WAIT FOR SERVICE) and blue section (timetable)
 * Returns { greenBuffer, blueBuffer } - either can be null if not detected
 */
async function splitGreenAndBlueSection(imagePath) {
  const image = sharp(imagePath);
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  
  // Analyze each row to find green-dominant rows
  // Green section typically has: high green, lower red/blue, or specific green tones
  const rowIsGreen = [];
  
  for (let y = 0; y < height; y++) {
    let greenPixelCount = 0;
    let totalPixels = 0;
    
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      
      // Detect green-ish colors (green channel significantly higher than red, or specific green tones)
      // Also detect dark backgrounds that might be part of green section
      const isGreenish = (g > r + 20 && g > b) || // Green dominant
                         (g > 100 && g > r && b < g) || // Light green
                         (r < 80 && g > 80 && b < 80) || // Pure green area
                         (r < 50 && g < 80 && b < 50); // Dark green/black area at top
      
      if (isGreenish) {
        greenPixelCount++;
      }
      totalPixels++;
    }
    
    // If more than 40% of the row is green-ish, consider it part of green section
    rowIsGreen.push(greenPixelCount / totalPixels > 0.4);
  }
  
  // Find the boundary - where green section ends
  // Look for transition from green to non-green (with some tolerance for noise)
  let greenEndRow = 0;
  let consecutiveNonGreen = 0;
  const TRANSITION_THRESHOLD = 5; // Need 5 consecutive non-green rows to confirm transition
  
  for (let y = 0; y < height; y++) {
    if (rowIsGreen[y]) {
      greenEndRow = y;
      consecutiveNonGreen = 0;
    } else {
      consecutiveNonGreen++;
      if (consecutiveNonGreen >= TRANSITION_THRESHOLD && greenEndRow > 0) {
        break;
      }
    }
  }
  
  // Add a small margin to ensure we capture all of the green section
  greenEndRow = Math.min(greenEndRow + 5, height - 1);
  
  console.log(`  Detected green section: rows 0-${greenEndRow} of ${height}`);
  
  // If green section is too small or too large, return null (no split)
  if (greenEndRow < 20 || greenEndRow > height - 20) {
    console.log('  No clear green/blue split detected, processing as single image');
    return { greenBuffer: null, blueBuffer: null };
  }
  
  // Split the image
  const greenBuffer = await sharp(imagePath)
    .extract({ left: 0, top: 0, width: width, height: greenEndRow + 1 })
    .png()
    .toBuffer();
  
  const blueBuffer = await sharp(imagePath)
    .extract({ left: 0, top: greenEndRow + 1, width: width, height: height - greenEndRow - 1 })
    .png()
    .toBuffer();
  
  return { greenBuffer, blueBuffer };
}

/**
 * Apply maximum quality preprocessing for better OCR
 * @param {boolean} invert - If true, invert the image for light text on dark backgrounds
 */
async function qualityPreprocess(imagePath, invert = false) {
  console.log('Applying quality preprocessing...' + (invert ? ' (inverted)' : ''));
  const image = sharp(imagePath);
  const metadata = await image.metadata();
  
  // Step 1: Upscale 4x with high-quality interpolation
  console.log('  - Upscaling 4x...');
  let processed = image
    .resize(metadata.width * 4, metadata.height * 4, { kernel: 'lanczos3' });
  
  // Step 2: Convert to grayscale
  console.log('  - Converting to grayscale...');
  processed = processed.grayscale();
  
  // Step 3: Normalize contrast (stretch histogram)
  console.log('  - Normalizing contrast...');
  processed = processed.normalize();
  
  // Step 4: Apply sharpening
  console.log('  - Sharpening...');
  processed = processed.sharpen({ sigma: 1.5, m1: 1.5, m2: 0.5 });
  
  // Step 5: Apply median filter to reduce noise
  console.log('  - Reducing noise...');
  processed = processed.median(3);
  
  // Step 6: Apply threshold to get pure black and white
  console.log('  - Applying threshold for pure B&W...');
  const { data: grayData, info: grayInfo } = await processed.raw().toBuffer({ resolveWithObject: true });
  
  const bwData = Buffer.alloc(grayData.length);
  const THRESHOLD = 128;
  
  for (let i = 0; i < grayData.length; i++) {
    if (invert) {
      // Inverted: light pixels become black (text), dark pixels become white (background)
      bwData[i] = grayData[i] >= THRESHOLD ? 0 : 255;
    } else {
      // Normal: dark pixels become black (text), light pixels become white (background)
      bwData[i] = grayData[i] < THRESHOLD ? 0 : 255;
    }
  }
  
  // Step 7: Thicken text slightly (1px dilation)
  console.log('  - Thickening text...');
  const width = grayInfo.width;
  const height = grayInfo.height;
  const thickenedData = Buffer.from(bwData);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (bwData[idx] === 0) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              thickenedData[ny * width + nx] = 0;
            }
          }
        }
      }
    }
  }
  
  const qualityImage = sharp(thickenedData, {
    raw: {
      width: grayInfo.width,
      height: grayInfo.height,
      channels: 1
    }
  });
  
  return qualityImage.png().toBuffer();
}

/**
 * Apply quality preprocessing to a buffer instead of file path
 * @param {Buffer} inputBuffer - PNG buffer to process
 * @param {boolean} invert - If true, invert for light text on dark backgrounds
 */
async function qualityPreprocessBuffer(inputBuffer, invert = false) {
  console.log('Applying quality preprocessing to buffer...' + (invert ? ' (inverted)' : ''));
  const image = sharp(inputBuffer);
  const metadata = await image.metadata();
  
  // Step 1: Upscale 4x with high-quality interpolation
  let processed = image
    .resize(metadata.width * 4, metadata.height * 4, { kernel: 'lanczos3' });
  
  // Step 2: Convert to grayscale
  processed = processed.grayscale();
  
  // Step 3: Normalize contrast (stretch histogram)
  processed = processed.normalize();
  
  // Step 4: Apply sharpening
  processed = processed.sharpen({ sigma: 1.5, m1: 1.5, m2: 0.5 });
  
  // Step 5: Apply median filter to reduce noise
  processed = processed.median(3);
  
  // Step 6: Apply threshold to get pure black and white
  const { data: grayData, info: grayInfo } = await processed.raw().toBuffer({ resolveWithObject: true });
  
  const bwData = Buffer.alloc(grayData.length);
  const THRESHOLD = 128;
  
  for (let i = 0; i < grayData.length; i++) {
    if (invert) {
      bwData[i] = grayData[i] >= THRESHOLD ? 0 : 255;
    } else {
      bwData[i] = grayData[i] < THRESHOLD ? 0 : 255;
    }
  }
  
  // Step 7: Thicken text slightly (1px dilation)
  const width = grayInfo.width;
  const height = grayInfo.height;
  const thickenedData = Buffer.from(bwData);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (bwData[idx] === 0) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              thickenedData[ny * width + nx] = 0;
            }
          }
        }
      }
    }
  }
  
  const qualityImage = sharp(thickenedData, {
    raw: {
      width: grayInfo.width,
      height: grayInfo.height,
      channels: 1
    }
  });
  
  return qualityImage.png().toBuffer();
}

/**
 * Extract service name from the first image (simple preprocessing, no inversion)
 */
async function extractServiceName(imagePath) {
  console.log('Processing SERVICE NAME image: ' + imagePath);
  try {
    // Use normal preprocessing only - service name is typically dark text on light background
    let imageInput = await qualityPreprocess(imagePath, false);
    
    // Single pass with SINGLE_LINE mode - optimized for service name
    const result = await Tesseract.recognize(imageInput, 'eng', {
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:+-()& []',
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
      preserve_interword_spaces: '1',
      logger: m => {
        if (m.status === 'recognizing text') {
          console.log('Progress: ' + Math.round(m.progress * 100) + '%');
        }
      }
    });
    
    return result.data.text;
  } catch (error) {
    console.error('Error processing service name ' + imagePath + ':', error);
    return null;
  }
}

/**
 * Extract timetable data from images with mixed backgrounds
 * Automatically splits green section (WAIT FOR SERVICE) from blue section (timetable)
 * (white text on green background + black text on blue/light background)
 */
async function extractTimetableText(imagePath) {
  console.log('Processing TIMETABLE image: ' + imagePath);
  try {
    // Try to split the image into green and blue sections
    const { greenBuffer, blueBuffer } = await splitGreenAndBlueSection(imagePath);
    
    let greenText = '';
    let blueText = '';
    
    if (greenBuffer && blueBuffer) {
      // Process green section with inverted preprocessing (light text on dark background)
      console.log('Processing GREEN section (inverted)...');
      const greenInput = await qualityPreprocessBuffer(greenBuffer, true);
      const greenResult = await Tesseract.recognize(greenInput, 'eng', {
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:+-()& []',
        tessedit_pageseg_mode: Tesseract.PSM.AUTO,
        preserve_interword_spaces: '1',
        logger: m => {
          if (m.status === 'recognizing text') {
            console.log('Green section progress: ' + Math.round(m.progress * 100) + '%');
          }
        }
      });
      greenText = greenResult.data.text;
      
      // Process blue section with normal preprocessing (dark text on light background)
      console.log('Processing BLUE section (normal)...');
      const blueInput = await qualityPreprocessBuffer(blueBuffer, false);
      const blueResult = await Tesseract.recognize(blueInput, 'eng', {
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:+-()& []',
        tessedit_pageseg_mode: Tesseract.PSM.AUTO,
        preserve_interword_spaces: '1',
        logger: m => {
          if (m.status === 'recognizing text') {
            console.log('Blue section progress: ' + Math.round(m.progress * 100) + '%');
          }
        }
      });
      blueText = blueResult.data.text;
      
      // Combine: green section first (WAIT FOR SERVICE), then blue section
      return greenText.trim() + '\n' + blueText.trim();
    } else {
      // Fallback: process entire image with both normal and inverted preprocessing
      console.log('Using fallback dual-pass processing...');
      
      // Normal preprocessing for dark text on light background (blue section)
      let imageInput = await qualityPreprocess(imagePath, false);
      
      // First pass - standard OCR
      const result = await Tesseract.recognize(imageInput, 'eng', {
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:+-()& []',
        tessedit_pageseg_mode: Tesseract.PSM.AUTO,
        preserve_interword_spaces: '1',
        logger: m => {
          if (m.status === 'recognizing text') {
            console.log('Progress: ' + Math.round(m.progress * 100) + '%');
          }
        }
      });
      
      // Second pass - inverted preprocessing for light text on dark background (green section)
      console.log('Second pass with inverted preprocessing (for green sections)...');
      const invertedInput = await qualityPreprocess(imagePath, true);
      const result2 = await Tesseract.recognize(invertedInput, 'eng', {
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:+-()& []',
        tessedit_pageseg_mode: Tesseract.PSM.AUTO,
        preserve_interword_spaces: '1'
      });
      
      // Combine results - prioritize inverted results for WAIT FOR SERVICE
      let combinedText = result.data.text;
      const allLines = new Set(result.data.text.split('\n').map(l => l.trim()).filter(l => l.length > 0));
      
      // Add unique lines from inverted pass
      const invertedLines = result2.data.text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      invertedLines.forEach(line => {
        if (!allLines.has(line) && line.length > 0) {
          // Prepend WAIT FOR SERVICE lines to ensure they appear first
          if (line.includes('WAIT FOR SERVICE')) {
            combinedText = line + '\n' + combinedText;
          } else {
            combinedText += '\n' + line;
          }
          allLines.add(line);
        }
      });
      
      return combinedText;
    }
  } catch (error) {
    console.error('Error processing timetable ' + imagePath + ':', error);
    return null;
  }
}

/**
 * Legacy function - kept for compatibility, now routes to appropriate specialized function
 */
async function extractTextFromImage(imagePath) {
  // Default to timetable extraction
  return extractTimetableText(imagePath);
}

function parseTrainTimetable(text) {
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  const rows = [];
  let serviceName = '';

  console.log('\nExtracted text:');
  console.log('='.repeat(70));
  lines.forEach((line, i) => { console.log(i + ': ' + line.trim()); });
  console.log('='.repeat(70));

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (/^[A-Za-z0-9]+(:|-)/.test(trimmedLine) && !serviceName) {
      // Extract service name and clean up trailing garbage
      let extracted = trimmedLine;
      // Remove anything starting with brackets/parens that contain non-standard chars
      extracted = extracted.replace(/\s*[\[\(][^\]\)]*[\]\)].*$/g, '');
      // Temporarily replace ' & ' with a safe placeholder to protect it
      extracted = extracted.replace(/ & /g, ' XANDX ');
      // Remove any remaining special characters and extra text at the end
      extracted = extracted.replace(/\s*[^\w\s:-]+.*$/g, '');
      // Restore the protected ' & '
      extracted = extracted.replace(/ XANDX /g, ' & ');
      serviceName = extracted.trim();
      continue;
    }
    if (trimmedLine.includes('STOP AT LOCATION')) {
      const parts = trimmedLine.replace('STOP AT LOCATION', '').trim();
      const platformMatch = parts.match(/Platform (\d+)/);
      const platform = platformMatch ? platformMatch[1] : '';
      let location = '';
      if (platformMatch) { 
        location = parts.substring(0, platformMatch.index).trim(); 
      } else {
        // If no platform match, extract location from the text before the dash/hyphen or use all text
        location = parts.replace(/\s*-\s*$/, '').trim();
      }
      const times = parts.match(/([+-]?\d{2}:\d{2}:\d{2})/g) || [];
      const arrival = times[0] ? times[0].replace(/[+-]/g, '') : '';
      rows.push({ action: 'STOP', location, platform, scheduledTime: '', arrival, departure: '' });
    } else if (trimmedLine.includes('UNLOAD PASSENGERS')) {
      // UNLOAD PASSENGERS is the final stop - usually has no time or just a dash
      const times = trimmedLine.match(/([+-]?\d{2}:\d{2}:\d{2})/g) || [];
      const time = times[0] ? times[0].replace(/[+-]/g, '') : '';
      rows.push({ action: 'UNLOAD PASSENGERS', location: '', platform: '', scheduledTime: '', arrival: '', departure: time });
    } else if (trimmedLine.includes('LOAD PASSENGERS')) {
      const times = trimmedLine.match(/([+-]?\d{2}:\d{2}:\d{2})/g) || [];
      const time = times[0] ? times[0].replace(/[+-]/g, '') : '';
      rows.push({ action: 'LOAD PASSENGERS', location: '', platform: '', scheduledTime: '', arrival: '', departure: time });
    } else if (trimmedLine.includes('WAIT FOR SERVICE')) {
      // Match various time formats including HH:MM:SS and potentially malformed ones
      const timeMatch = trimmedLine.match(/(\d{1,2}:\d{1,2}:\d{2}(?::\d{2})?)/);
      if (timeMatch) {
        let time = timeMatch[1];
        // Clean up malformed times like "0:5:33:00" to "05:33:00"
        const timeParts = time.split(':');
        if (timeParts.length === 4) {
          // Format like "0:5:33:00" - take last three parts
          time = timeParts.slice(1).join(':');
        } else if (timeParts.length === 3) {
          // Pad single digit hours/minutes
          time = timeParts.map((part, i) => i < 2 ? part.padStart(2, '0') : part).join(':');
        }
        // Initially set departure to empty - will be filled later if needed
        rows.push({ action: 'WAIT FOR SERVICE', location: '', platform: '', scheduledTime: '', arrival: time, departure: '' });
      }
    }
  }
  return { rows, serviceName };
}

function deduplicateRows(data) {
  const seen = new Set();
  return data.filter(row => {
    const key = JSON.stringify(row);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function writeToCSV(data, serviceNames, extraData) {
  if (!fs.existsSync(OUTPUT_CSV_DIR)) {
    fs.mkdirSync(OUTPUT_CSV_DIR, { recursive: true });
  }
  
  let filename = 'timetable_original.csv';
  
  if (serviceNames.length > 0) {
    let fullService = serviceNames[0];
    // Remove unwanted characters but preserve ' & ' (ampersand with spaces)
    fullService = fullService.replace(/[\[\]\(\)%¥£€$@#*!~`^{}|]/g, '').replace(/&(?! )/g, '').replace(/(?<! )&/g, '').trim();
    // Remove colon and replace other filesystem-unsafe characters with hyphen
    const safeFilename = fullService.replace(/:/g, '').replace(/[<>"/\\|?*]/g, '-');
    filename = safeFilename + '.csv';
  }
  
  const outputFile = path.join(OUTPUT_CSV_DIR, filename);
  
  const csvLines = [];
  csvLines.push('Action,Location,Platform,Arrival,Departure');
  
  let firstWaitProcessed = false;
  data.forEach(row => {
    // Use command-line args only for the first WAIT FOR SERVICE
    let location = row.location || '';
    let platform = row.platform || '';
    
    if (row.action === 'WAIT FOR SERVICE' && extraData && !firstWaitProcessed) {
      if (!location && extraData.firstDestination) {
        location = extraData.firstDestination;
      }
      if (!platform && extraData.firstPlatform) {
        platform = extraData.firstPlatform;
      }
      firstWaitProcessed = true;
    }
    
    const line = [
      row.action || '',
      location,
      platform,
      row.arrival || '',
      row.departure || ''
    ].map(field => {
      if (field.includes(',') || field.includes('"') || field.includes('\n')) {
        return '"' + field.replace(/"/g, '""') + '"';
      }
      return field;
    }).join(',');
    csvLines.push(line);
  });
  fs.writeFileSync(outputFile, csvLines.join('\n'));
  console.log('\nCSV Format 1 created: ' + outputFile);
}

function writeToCSVSimple(data, serviceNames, extraData) {
  if (!fs.existsSync(OUTPUT_THIRDRAILS_DIR)) {
    fs.mkdirSync(OUTPUT_THIRDRAILS_DIR, { recursive: true });
  }
  
  let filename = 'timetable_thirdrails.csv';
  
  if (serviceNames.length > 0) {
    let fullService = serviceNames[0];
    // Remove unwanted characters but preserve ' & ' (ampersand with spaces)
    fullService = fullService.replace(/[\[\]\(\)%¥£€$@#*!~`^{}|]/g, '').replace(/&(?! )/g, '').replace(/(?<! )&/g, '').trim();
    // Remove colon and replace other filesystem-unsafe characters with hyphen
    const safeFilename = fullService.replace(/:/g, '').replace(/[<>"/\\|?*]/g, '-');
    filename = safeFilename + '.csv';
  }
  
  const outputFile = path.join(OUTPUT_THIRDRAILS_DIR, filename);
  
  const csvLines = [];
  csvLines.push('Destination,Arrival,Departure,Platform');
  
  // Find the first WAIT FOR SERVICE and first LOAD PASSENGERS for the initial line
  let firstArrival = '';
  let firstDeparture = '';
  let startIndex = 0;
  
  for (let i = 0; i < data.length; i++) {
    if (data[i].action === 'WAIT FOR SERVICE' && !firstArrival) {
      firstArrival = data[i].arrival || '';
      // Don't use departure from WAIT FOR SERVICE for thirdrails format
      startIndex = i + 1;
    } else if (data[i].action === 'LOAD PASSENGERS' && firstArrival && !firstDeparture) {
      firstDeparture = data[i].departure || '';
      startIndex = i + 1;
      break;
    }
  }
  
  // If no LOAD PASSENGERS found after WAIT FOR SERVICE, use arrival as departure
  if (firstArrival && !firstDeparture) {
    firstDeparture = firstArrival;
  }
  
  // Add first line with optional destination/platform from command line args
  if (firstArrival || firstDeparture) {
    const firstLine = [
      extraData && extraData.firstDestination ? extraData.firstDestination : '',
      firstArrival,
      firstDeparture,
      extraData && extraData.firstPlatform ? extraData.firstPlatform : ''
    ].map(field => {
      if (field.includes(',') || field.includes('"') || field.includes('\n')) {
        return '"' + field.replace(/"/g, '""') + '"';
      }
      return field;
    }).join(',');
    csvLines.push(firstLine);
  }
  
  // Process remaining entries - pair each STOP with its following LOAD PASSENGERS
  for (let i = startIndex; i < data.length; i++) {
    const row = data[i];
    if (row.action === 'STOP') {
      let departure = '';
      // Look for the next LOAD PASSENGERS
      if (i + 1 < data.length && data[i + 1].action === 'LOAD PASSENGERS') {
        departure = data[i + 1].departure || '';
      }
      
      const line = [
        row.location || '',
        row.arrival || '',
        departure,
        row.platform || ''
      ].map(field => {
        if (field.includes(',') || field.includes('"') || field.includes('\n')) {
          return '"' + field.replace(/"/g, '""') + '"';
        }
        return field;
      }).join(',');
      csvLines.push(line);
    }
  }
  fs.writeFileSync(outputFile, csvLines.join('\n'));
  console.log('ThirdRails CSV created: ' + outputFile);
}

function writeToJSONRouteSkeleton(data, serviceNames, extraData) {
  if (!fs.existsSync(OUTPUT_UNPROCESSED_DIR)) {
    fs.mkdirSync(OUTPUT_UNPROCESSED_DIR, { recursive: true });
  }
  
  let filename = 'raw_data_template.json';
  
  if (serviceNames.length > 0) {
    let fullService = serviceNames[0];
    // Remove unwanted characters but preserve ' & ' (ampersand with spaces)
    fullService = fullService.replace(/[[\]()%¥£€$@#*!~`^{}|]/g, '').replace(/&(?! )/g, '').replace(/(?<! )&/g, '').trim();
    // Remove colon and replace other filesystem-unsafe characters with hyphen
    const safeFilename = fullService.replace(/:/g, '').replace(/[<>"/\\|?*]/g, '-');
    filename = 'raw_data_' + safeFilename + '.json';
  }
  
  const outputFile = path.join(OUTPUT_UNPROCESSED_DIR, filename);
  
  // Build timetable array from the data
  const timetable = [];
  let index = 0;
  
  // Find the first WAIT FOR SERVICE and first LOAD PASSENGERS for the initial entry
  let firstArrival = '';
  let firstDeparture = '';
  let startIndex = 0;
  
  for (let i = 0; i < data.length; i++) {
    if (data[i].action === 'WAIT FOR SERVICE' && !firstArrival) {
      firstArrival = data[i].arrival || '';
      startIndex = i + 1;
    } else if (data[i].action === 'LOAD PASSENGERS' && firstArrival && !firstDeparture) {
      firstDeparture = data[i].departure || '';
      startIndex = i + 1;
      break;
    }
  }
  
  if (!firstDeparture && firstArrival) {
    firstDeparture = firstArrival;
  }
  
  // Add first entry
  if (firstArrival || firstDeparture) {
    const firstDest = extraData && extraData.firstDestination ? extraData.firstDestination : '';
    const firstPlat = extraData && extraData.firstPlatform ? extraData.firstPlatform : '';
    const mappedFirstDest = getMappedStationName(stationMappings, firstDest);
    const firstApiName = mappedFirstDest && firstPlat ? mappedFirstDest + ' ' + firstPlat : '';
    
    timetable.push({
      index: index++,
      destination: firstDest,
      arrival: firstArrival,
      departure: firstDeparture,
      platform: firstPlat,
      apiName: firstApiName,
      longitude: null,
      latitude: null
    });
  }
  
  // Process remaining entries
  for (let i = startIndex; i < data.length; i++) {
    const row = data[i];
    if (row.action === 'STOP') {
      let departure = '';
      if (i + 1 < data.length && data[i + 1].action === 'LOAD PASSENGERS') {
        departure = data[i + 1].departure || '';
      }
      
      const destination = row.location || '';
      const platform = row.platform || '';
      const mappedDestination = getMappedStationName(stationMappings, destination);
      const apiName = mappedDestination && platform ? mappedDestination + ' ' + platform : '';
      
      timetable.push({
        index: index++,
        destination: destination,
        arrival: row.arrival || '',
        departure: departure,
        platform: platform,
        apiName: apiName,
        longitude: null,
        latitude: null
      });
    }
  }
  
  // Create the route skeleton JSON
  const routeSkeleton = {
    routeName: serviceNames.length > 0 ? serviceNames[0] : 'Unknown Route',
    totalPoints: 0,
    totalMarkers: 0,
    duration: 0,
    requestCount: 0,
    coordinates: [],
    markers: [],
    timetable: timetable
  };
  
  fs.writeFileSync(outputFile, JSON.stringify(routeSkeleton, null, 2));
  console.log('Route skeleton JSON created: ' + outputFile);
  console.log('  This file is ready to be used with server.js for route recording');
}

function writeToThirdRails(data, serviceNames) {
  if (!fs.existsSync(OUTPUT_THIRDRAILS_DIR)) {
    fs.mkdirSync(OUTPUT_THIRDRAILS_DIR, { recursive: true });
  }
  
  let filename = 'timetable_thirdrails.csv';
  
  if (serviceNames.length > 0) {
    let fullService = serviceNames[0];
    // Remove unwanted characters but preserve ' & ' (ampersand with spaces)
    fullService = fullService.replace(/[\[\]\(\)%¥£€$@#*!~`^{}|]/g, '').replace(/&(?! )/g, '').replace(/(?<! )&/g, '').trim();
    // Remove colon and replace other filesystem-unsafe characters with hyphen
    const safeFilename = fullService.replace(/:/g, '').replace(/[<>"/\\|?*]/g, '-');
    filename = safeFilename + '.csv';
  }
  
  const outputFile = path.join(OUTPUT_THIRDRAILS_DIR, filename);
  
  const csvLines = [];
  csvLines.push('Departure,Origin,PI,ServiceDestination,ID,TOC,Type');
  
  data.forEach((row, index) => {
    if (row.action === 'STOP' || row.action === 'LOAD PASSENGERS') {
      const line = [
        row.departure || row.arrival || '',
        row.location || '',
        row.platform || '',
        row.location || '',
        (index + 1).toString(),
        '',
        row.action
      ].map(field => {
        if (field.includes(',') || field.includes('"') || field.includes('\n')) {
          return '"' + field.replace(/"/g, '""') + '"';
        }
        return field;
      }).join(',');
      csvLines.push(line);
    }
  });
  fs.writeFileSync(outputFile, csvLines.join('\n'));
  console.log('ThirdRails CSV created: ' + outputFile);
}

async function main() {
  // Parse command line arguments
  // Usage: node extract.js <platform_number> <initial_platform_name> <file_name>
  // Example: node extract.js 2 "West Side" "qwF5-1  Town & Hill to City"
  const args = process.argv.slice(2);
  let firstPlatform = args[0] || '';
  let firstDestination = args[1] || '';
  let customFilename = args[2] || '';
  
  if (firstPlatform || firstDestination || customFilename) {
    console.log('Command line arguments:');
    console.log('  Platform number: ' + (firstPlatform || '(none)'));
    console.log('  Initial platform name: ' + (firstDestination || '(none)'));
    console.log('  Custom filename: ' + (customFilename || '(none)'));
  }
  
  console.log('Starting timetable OCR processing...\n');
  const files = fs.readdirSync(IMAGE_DIR).filter(file => /\.(png|jpg|jpeg|gif|bmp)$/i.test(file)).sort();
  if (files.length === 0) { console.log('No image files found.'); return; }
  if (files.length < 2) { console.log('Need at least 2 images (service name + data).'); return; }
  
  console.log('Found ' + files.length + ' image(s) to process in order:');
  files.forEach((file, idx) => { console.log('  ' + (idx + 1) + '. ' + file); });
  console.log('');
  
  const allData = [];
  let serviceName = '';
  let allOCRText = [];
  
  // Store first platform and destination for later use
  const extraData = { firstPlatform, firstDestination };
  
  // Process first image for service name only (uses specialized function)
  console.log('\n' + '='.repeat(70));
  console.log('Processing image 1 (SERVICE NAME): ' + files[0]);
  console.log('='.repeat(70));
  const serviceImagePath = path.join(IMAGE_DIR, files[0]);
  const serviceText = await extractServiceName(serviceImagePath);
  if (serviceText) {
    allOCRText.push('='.repeat(70));
    allOCRText.push('File: ' + files[0] + ' (SERVICE NAME)');
    allOCRText.push('='.repeat(70));
    allOCRText.push(serviceText);
    allOCRText.push('\n');
    
    const result = parseTrainTimetable(serviceText);
    if (result.serviceName) {
      serviceName = result.serviceName;
      console.log('Service name extracted: ' + serviceName);
    }
  }
  
  // Process remaining images for timetable data (uses specialized function for mixed backgrounds)
  for (let i = 1; i < files.length; i++) {
    const file = files[i];
    console.log('\n' + '='.repeat(70));
    console.log('Processing image ' + (i + 1) + ' of ' + files.length + ': ' + file);
    console.log('='.repeat(70));
    const imagePath = path.join(IMAGE_DIR, file);
    const text = await extractTimetableText(imagePath);
    if (text) {
      // Save raw OCR text
      allOCRText.push('='.repeat(70));
      allOCRText.push('File: ' + file);
      allOCRText.push('='.repeat(70));
      allOCRText.push(text);
      allOCRText.push('\n');
      
      const result = parseTrainTimetable(text);
      if (result.rows.length > 0) {
        console.log('Extracted ' + result.rows.length + ' rows from this image');
        allData.push(...result.rows);
      }
    }
  }
  
  // Write raw OCR output to file
  if (allOCRText.length > 0) {
    fs.writeFileSync('./ocr_raw_output.txt', allOCRText.join('\n'));
    console.log('\nRaw OCR output saved to: ocr_raw_output.txt');
  }
  
  if (allData.length > 0) {
    const dedupedData = deduplicateRows(allData);
    const duplicatesRemoved = allData.length - dedupedData.length;
    if (duplicatesRemoved > 0) {
      console.log('\nRemoved ' + duplicatesRemoved + ' duplicate entries');
    }
    
    // Post-process WAIT FOR SERVICE entries: set departure to arrival if next line is NOT LOAD PASSENGERS
    for (let i = 0; i < dedupedData.length; i++) {
      if (dedupedData[i].action === 'WAIT FOR SERVICE' && !dedupedData[i].departure) {
        // Check if next row exists and is LOAD PASSENGERS
        const nextRow = i + 1 < dedupedData.length ? dedupedData[i + 1] : null;
        if (!nextRow || nextRow.action !== 'LOAD PASSENGERS') {
          // If there's no next row, or next row is not LOAD PASSENGERS, use arrival as departure
          dedupedData[i].departure = dedupedData[i].arrival;
        }
      }
    }
    
    // Use custom filename if provided from command line
    if (customFilename) {
      serviceName = customFilename;
      console.log('Using custom filename from command line: ' + serviceName);
    }
    
    const allServiceNames = serviceName ? [serviceName] : [];
    writeToCSV(dedupedData, allServiceNames, extraData);
    writeToCSVSimple(dedupedData, allServiceNames, extraData);
    writeToJSONRouteSkeleton(dedupedData, allServiceNames, extraData);
    console.log('\n' + '='.repeat(70));
    console.log('FINAL COMBINED TIMETABLE');
    console.log('='.repeat(70));
    if (serviceName) { 
      console.log('Service: ' + serviceName); 
    }
    console.log('Total ' + dedupedData.length + ' rows extracted from ' + (files.length - 1) + ' data image(s).');
    console.log('\nCombined timetable preview:');
    console.log('Action              | Location          | Platform | Arrival  | Departure');
    console.log('-'.repeat(85));
    
    let firstWaitProcessed = false;
    dedupedData.forEach(row => {
      let displayPlatform = row.platform || '';
      // Apply command-line platform to first WAIT FOR SERVICE
      if (row.action === 'WAIT FOR SERVICE' && extraData && !firstWaitProcessed && extraData.firstPlatform) {
        displayPlatform = extraData.firstPlatform;
        firstWaitProcessed = true;
      }
      console.log((row.action || '').padEnd(19) + ' | ' + (row.location || '').padEnd(17) + ' | ' + displayPlatform.padEnd(8) + ' | ' + (row.arrival || '').padEnd(8) + ' | ' + (row.departure || ''));
    });
  } else { console.log('\nNo data extracted from images.'); }
}

main().catch(console.error).then(async () => {
  // Find the last written raw_data_*.json file
  const unprocessedDir = OUTPUT_UNPROCESSED_DIR;
  const rawDataDir = path.resolve('./raw_data');
  if (!fs.existsSync(rawDataDir)) {
    fs.mkdirSync(rawDataDir, { recursive: true });
  }
  const files = fs.readdirSync(unprocessedDir).filter(f => f.startsWith('raw_data_') && f.endsWith('.json'));
  if (files.length > 0) {
    // Get the most recently modified file
    const latest = files.map(f => ({
      file: f,
      mtime: fs.statSync(path.join(unprocessedDir, f)).mtimeMs
    })).sort((a, b) => b.mtime - a.mtime)[0].file;
    const base = latest.replace(/\.json$/, '');
    const destDir = path.join(rawDataDir, base);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    // Move all images from timetable_images to destDir
    const images = fs.readdirSync(IMAGE_DIR).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
    for (const img of images) {
      const src = path.join(IMAGE_DIR, img);
      const dest = path.join(destDir, img);
      fs.renameSync(src, dest);
      console.log(`Moved image ${img} to ${destDir}`);
    }
  }
});
