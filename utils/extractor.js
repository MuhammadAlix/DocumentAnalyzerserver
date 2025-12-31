const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

function extractPPTX(filePath) {
  try {
    const zip = new AdmZip(filePath);
    let text = "";
    const zipEntries = zip.getEntries();
    const slideEntries = zipEntries.filter(entry => 
      entry.entryName.startsWith('ppt/slides/slide') && entry.entryName.endsWith('.xml')
    );
    slideEntries.sort((a, b) => {
      const numA = parseInt(a.entryName.match(/slide(\d+)\.xml/)[1]);
      const numB = parseInt(b.entryName.match(/slide(\d+)\.xml/)[1]);
      return numA - numB;
    });
    slideEntries.forEach(entry => {
      const xmlContent = zip.readAsText(entry);
      const matches = xmlContent.match(/<a:t>([\s\S]*?)<\/a:t>/g);
      if (matches) {
        text += matches.map(m => m.replace(/<\/?a:t>/g, '')).join(' ') + "\n\n";
      }
    });
    return text || null;
  } catch (e) {
    console.error("PPTX Parsing failed:", e);
    return null;
  }
}
async function extractPdfText(filePath) {
  try {
    const data = new Uint8Array(fs.readFileSync(filePath));
    const loadingTask = pdfjsLib.getDocument({
      data: data,
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0
    });
    const pdfDocument = await loadingTask.promise;
    let fullText = "";
    for (let i = 1; i <= pdfDocument.numPages; i++) {
      const page = await pdfDocument.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      fullText += `--- Page ${i} ---\n${pageText}\n\n`;
    }
    return fullText;
  } catch (error) {
    console.error("PDF Parsing Failed:", error);
    return null;
  }
}
async function extractText(filePath, mimeType, originalName) {
  const ext = path.extname(originalName).toLowerCase();  
  console.log(`Extracting logic -> Ext: ${ext}, Mime: ${mimeType}`);
  try {
    if (ext === '.pdf' || mimeType === 'application/pdf') {
      return await extractPdfText(filePath);
    }
    if (ext === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }
    if (ext === '.xlsx' || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);
      let text = "";
      workbook.eachSheet((sheet) => {
        text += `--- Sheet: ${sheet.name} ---\n`;
        sheet.eachRow((row) => {
          const rowText = row.values
            .filter(val => val !== undefined && val !== null)
            .map(val => (typeof val === 'object' ? JSON.stringify(val) : val.toString()))
            .join(' ');
          text += rowText + "\n";
        });
        text += "\n";
      });
      return text;
    }
    if (ext === '.pptx' || mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
      return extractPPTX(filePath);
    }
    if (mimeType.startsWith('text/') || ext === '.txt' || ext === '.md' || ext === '.js') {
      return fs.readFileSync(filePath, 'utf8');
    }
    console.warn("Unsupported file type for extraction:", ext);
    return null; 
  } catch (error) {
    console.error("Manual Extraction Error:", error);
    return null;
  }
}
module.exports = { extractText };