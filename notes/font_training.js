const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');

/**
 * Font Training Helper for TSW Timetable OCR
 * 
 * This script helps you create training data for new fonts found in
 * Train Simulator World timetable images.
 */

const TRAINING_IMAGES_DIR = './training_images';
const TRAINING_OUTPUT_DIR = './training_data';

// Common TSW interface fonts and their characteristics
const TSW_FONT_PROFILES = {
  'service_header': {
    // Large bold text for service names like "2N04: Milton Keynes - London Euston"
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:- &',
    user_defined_dpi: '150'
  },
  'station_names': {
    // Medium text for station names
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_WORD,
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz& ',
    user_defined_dpi: '200'
  },
  'times': {
    // Small monospace text for times
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
    tessedit_char_whitelist: '0123456789:+- ',
    user_defined_dpi: '300'
  },
  'platform_numbers': {
    // Small text for platform numbers
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_WORD,
    tesseract_char_whitelist: '0123456789',
    user_defined_dpi: '400'
  }
};

async function analyzeFont(imagePath, fontType = 'service_header') {
  console.log(`Analyzing font in: ${imagePath} (type: ${fontType})`);
  
  const profile = TSW_FONT_PROFILES[fontType];
  if (!profile) {
    console.error(`Unknown font type: ${fontType}`);
    return null;
  }
  
  try {
    const result = await Tesseract.recognize(imagePath, 'eng', {
      ...profile,
      logger: m => {
        if (m.status === 'recognizing text') {
          console.log(`${fontType} progress: ${Math.round(m.progress * 100)}%`);
        }
      }
    });
    
    return {
      text: result.data.text.trim(),
      confidence: result.data.confidence,
      fontType: fontType,
      imagePath: imagePath
    };
  } catch (error) {
    console.error(`Error analyzing ${imagePath}:`, error);
    return null;
  }
}

async function createTrainingData(imageDir) {
  console.log('Creating training data from images in:', imageDir);
  
  if (!fs.existsSync(TRAINING_OUTPUT_DIR)) {
    fs.mkdirSync(TRAINING_OUTPUT_DIR, { recursive: true });
  }
  
  const images = fs.readdirSync(imageDir)
    .filter(file => /\.(png|jpg|jpeg|gif|bmp)$/i.test(file));
  
  const trainingData = [];
  
  for (const image of images) {
    const imagePath = path.join(imageDir, image);
    console.log(`\nProcessing: ${image}`);
    
    // Try different font types based on image name patterns
    let fontType = 'service_header'; // default
    if (image.toLowerCase().includes('station')) fontType = 'station_names';
    if (image.toLowerCase().includes('time')) fontType = 'times';
    if (image.toLowerCase().includes('platform')) fontType = 'platform_numbers';
    
    const result = await analyzeFont(imagePath, fontType);
    if (result) {
      trainingData.push(result);
      console.log(`Extracted: "${result.text}" (confidence: ${result.confidence.toFixed(2)}%)`);
    }
  }
  
  // Save training results
  const outputFile = path.join(TRAINING_OUTPUT_DIR, 'training_results.json');
  fs.writeFileSync(outputFile, JSON.stringify(trainingData, null, 2));
  console.log(`\nTraining data saved to: ${outputFile}`);
  
  // Generate ground truth files for manual correction
  trainingData.forEach((data, index) => {
    const baseFilename = path.basename(data.imagePath, path.extname(data.imagePath));
    const gtFile = path.join(TRAINING_OUTPUT_DIR, `${baseFilename}.gt.txt`);
    fs.writeFileSync(gtFile, data.text);
    console.log(`Ground truth file created: ${gtFile}`);
    console.log(`Please manually verify and correct the text in this file.`);
  });
  
  return trainingData;
}

// Enhanced OCR function with multiple font profiles
async function extractWithMultipleFontProfiles(imagePath) {
  const results = [];
  
  for (const [fontType, profile] of Object.entries(TSW_FONT_PROFILES)) {
    console.log(`Trying ${fontType} profile...`);
    try {
      const result = await Tesseract.recognize(imagePath, 'eng', profile);
      if (result.data.text.trim().length > 0) {
        results.push({
          fontType,
          text: result.data.text.trim(),
          confidence: result.data.confidence
        });
      }
    } catch (error) {
      console.warn(`Failed with ${fontType} profile:`, error.message);
    }
  }
  
  // Return best result by confidence
  if (results.length > 0) {
    const bestResult = results.reduce((best, current) => 
      current.confidence > best.confidence ? current : best
    );
    console.log(`Best result: ${bestResult.fontType} (${bestResult.confidence.toFixed(2)}%): "${bestResult.text}"`);
    return bestResult;
  }
  
  return null;
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'train':
      const trainingDir = args[1] || TRAINING_IMAGES_DIR;
      if (!fs.existsSync(trainingDir)) {
        console.error(`Training images directory not found: ${trainingDir}`);
        console.log('Please create the directory and add sample images of different font types.');
        process.exit(1);
      }
      await createTrainingData(trainingDir);
      break;
      
    case 'test':
      const testImage = args[1];
      if (!testImage || !fs.existsSync(testImage)) {
        console.error('Please provide a valid image path to test.');
        process.exit(1);
      }
      await extractWithMultipleFontProfiles(testImage);
      break;
      
    default:
      console.log(`
Font Training Tool for TSW Timetable OCR

Usage:
  node font_training.js train [training_images_dir]  - Create training data from images
  node font_training.js test <image_path>            - Test font recognition on a single image

Examples:
  node font_training.js train ./training_images
  node font_training.js test ./test_image.png

Directory Structure:
  training_images/          - Put your sample images here
    ├── service_header_1.png    - Service name examples
    ├── station_names_1.png     - Station name examples  
    ├── times_1.png             - Time display examples
    └── platform_numbers_1.png  - Platform number examples
      `);
      break;
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  analyzeFont,
  createTrainingData,
  extractWithMultipleFontProfiles,
  TSW_FONT_PROFILES
};