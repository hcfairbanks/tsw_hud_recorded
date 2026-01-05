const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');

const IMAGE_DIR = './timetable_images';
const OUTPUT_TXT = './timetable_formatted.txt';
const OUTPUT_CSV_DIR = './formats/csv';
const OUTPUT_HUD_DIR = './formats/hud';
const OUTPUT_THIRDRAILS_DIR = './formats/thirdrails';
const OUTPUT_UNPROCESSED_DIR = './unprocessed_routes';

async function extractTextFromImage(imagePath) {
  console.log('Processing image: ' + imagePath);
  try {
    // First pass - standard OCR
    const result = await Tesseract.recognize(imagePath, 'eng', {
      logger: m => {
        if (m.status === 'recognizing text') {
          console.log('Progress: ' + Math.round(m.progress * 100) + '%');
        }
      }
    });
    
    // Second pass - with different settings to capture colored/faint text
    console.log('Second pass for additional text...');
    const result2 = await Tesseract.recognize(imagePath, 'eng', {
      tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT
    });
    
    // Combine both results
    let combinedText = result.data.text;
    const lines1 = new Set(result.data.text.split('\n').map(l => l.trim()).filter(l => l.length > 0));
    const lines2 = result2.data.text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    // Add lines from second pass that aren't in first pass
    lines2.forEach(line => {
      if (!lines1.has(line) && line.length > 0) {
        combinedText += '\n' + line;
      }
    });
    
    return combinedText;
  } catch (error) {
    console.error('Error processing ' + imagePath + ':', error);
    return null;
  }
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

function writeToHUD(data, serviceNames, extraData) {
  if (!fs.existsSync(OUTPUT_HUD_DIR)) {
    fs.mkdirSync(OUTPUT_HUD_DIR, { recursive: true });
  }
  
  let filename = 'timetable_hud.csv';
  
  if (serviceNames.length > 0) {
    let fullService = serviceNames[0];
    // Remove unwanted characters but preserve ' & ' (ampersand with spaces)
    fullService = fullService.replace(/[\[\]\(\)%¥£€$@#*!~`^{}|]/g, '').replace(/&(?! )/g, '').replace(/(?<! )&/g, '').trim();
    // Remove colon and replace other filesystem-unsafe characters with hyphen
    const safeFilename = fullService.replace(/:/g, '').replace(/[<>"/\\|?*]/g, '-');
    filename = safeFilename + '.csv';
  }
  
  const outputFile = path.join(OUTPUT_HUD_DIR, filename);
  
  const csvLines = [];
  csvLines.push('Destination,Arrival,Departure,Platform,api_name');
  
  // Find the first WAIT FOR SERVICE and first LOAD PASSENGERS for the initial line
  let firstArrival = '';
  let firstDeparture = '';
  let startIndex = 0;
  
  for (let i = 0; i < data.length; i++) {
    if (data[i].action === 'WAIT FOR SERVICE' && !firstArrival) {
      firstArrival = data[i].arrival || '';
      // Don't use departure from WAIT FOR SERVICE for HUD format
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
    const firstDestination = extraData && extraData.firstDestination ? extraData.firstDestination : '';
    const firstPlatform = extraData && extraData.firstPlatform ? extraData.firstPlatform : '';
    const apiName = firstDestination && firstPlatform ? firstDestination + ' ' + firstPlatform : '';
    
    const firstLine = [
      firstDestination,
      firstArrival,
      firstDeparture,
      firstPlatform,
      apiName
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
      
      const destination = row.location || '';
      const platform = row.platform || '';
      const apiName = destination && platform ? destination + ' ' + platform : '';
      
      const line = [
        destination,
        row.arrival || '',
        departure,
        platform,
        apiName
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
  console.log('HUD CSV created: ' + outputFile);
}

function writeToJSONRouteSkeleton(data, serviceNames, extraData) {
  if (!fs.existsSync(OUTPUT_UNPROCESSED_DIR)) {
    fs.mkdirSync(OUTPUT_UNPROCESSED_DIR, { recursive: true });
  }
  
  let filename = 'route_template.json';
  
  if (serviceNames.length > 0) {
    let fullService = serviceNames[0];
    // Remove unwanted characters but preserve ' & ' (ampersand with spaces)
    fullService = fullService.replace(/[\[\]\(\)%¥£€$@#*!~`^{}|]/g, '').replace(/&(?! )/g, '').replace(/(?<! )&/g, '').trim();
    // Remove colon and replace other filesystem-unsafe characters with hyphen
    const safeFilename = fullService.replace(/:/g, '').replace(/[<>"/\\|?*]/g, '-');
    filename = 'route_' + safeFilename + '.json';
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
    const firstApiName = firstDest && firstPlat ? firstDest + ' ' + firstPlat : '';
    
    timetable.push({
      index: index++,
      destination: firstDest,
      arrival: firstArrival,
      departure: firstDeparture,
      platform: firstPlat,
      apiName: firstApiName
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
      const apiName = destination && platform ? destination + ' ' + platform : '';
      
      timetable.push({
        index: index++,
        destination: destination,
        arrival: row.arrival || '',
        departure: departure,
        platform: platform,
        apiName: apiName
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
  
  // Process first image for service name only
  console.log('\n' + '='.repeat(70));
  console.log('Processing image 1 (SERVICE NAME): ' + files[0]);
  console.log('='.repeat(70));
  const serviceImagePath = path.join(IMAGE_DIR, files[0]);
  const serviceText = await extractTextFromImage(serviceImagePath);
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
  
  // Process remaining images for timetable data
  for (let i = 1; i < files.length; i++) {
    const file = files[i];
    console.log('\n' + '='.repeat(70));
    console.log('Processing image ' + (i + 1) + ' of ' + files.length + ': ' + file);
    console.log('='.repeat(70));
    const imagePath = path.join(IMAGE_DIR, file);
    const text = await extractTextFromImage(imagePath);
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
    writeToHUD(dedupedData, allServiceNames, extraData);
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

main().catch(console.error);
