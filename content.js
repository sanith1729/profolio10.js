// content.js - Content script for form detection and filling

// State
let analysisResults = null;
let isAnalyzing = false;

// Listen for messages from the extension
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startAnalysis') {
    if (isAnalyzing) {
      sendResponse({success: false, error: 'Analysis already in progress'});
      return true;
    }
    
    analyzeCurrentPage()
      .then(results => {
        analysisResults = results;
        sendResponse({success: true, analysis: results});
      })
      .catch(error => {
        console.error('Analysis error:', error);
        sendResponse({success: false, error: error.message});
      })
      .finally(() => {
        isAnalyzing = false;
      });
    
    return true; // Required for async sendResponse
  }
  
  if (message.action === 'fillForm') {
    if (!analysisResults) {
      sendResponse({success: false, error: 'Please analyze the form first'});
      return true;
    }
    
    fillFormWithResults()
      .then(result => {
        sendResponse({success: true, filledCount: result.filledCount});
      })
      .catch(error => {
        console.error('Form fill error:', error);
        sendResponse({success: false, error: error.message});
      });
    
    return true; // Required for async sendResponse
  }
});

// Analyze the current page
async function analyzeCurrentPage() {
  try {
    isAnalyzing = true;
    
    // Collect form data
    const formData = gatherFormData();
    
    // Check if we found any forms
    if (formData.length === 0) {
      throw new Error('No forms detected on this page');
    }
    
    // Take screenshot using html2canvas (must be loaded)
    let screenshot = null;
    
    try {
      // Load html2canvas if not already loaded
      if (typeof html2canvas === 'undefined') {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
          script.onload = resolve;
          script.onerror = () => reject(new Error('Failed to load html2canvas'));
          document.head.appendChild(script);
        });
      }
      
      const canvas = await html2canvas(document.body, {
        scale: 0.5,  // Lower scale for performance
        logging: false,
        useCORS: true,
        allowTaint: true
      });
      
      screenshot = canvas.toDataURL('image/jpeg', 0.7);
    } catch (screenshotError) {
      console.error('Screenshot error:', screenshotError);
      // Continue without screenshot if it fails
    }
    
    // Send data to background script for API call
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'analyzeForm',
        formData,
        screenshot
      }, response => {
        if (response && response.success) {
          resolve(response.analysis);
        } else {
          reject(new Error(response?.error || 'Analysis failed'));
        }
      });
    });
  } catch (error) {
    isAnalyzing = false;
    throw error;
  }
}

// Gather form data from the page
function gatherFormData() {
  const forms = [];
  
  // Find all forms
  document.querySelectorAll('form').forEach((form, formIndex) => {
    const formElements = [];
    
    // Get all inputs, selects, and textareas
    form.querySelectorAll('input, select, textarea').forEach((element, elementIndex) => {
      // Skip hidden fields and submit buttons
      if (element.type === 'hidden' || element.type === 'submit' || element.type === 'button') {
        return;
      }
      
      // Try to find label
      let labelText = '';
      
      // Check for label with 'for' attribute
      if (element.id) {
        const label = document.querySelector(`label[for="${element.id}"]`);
        if (label) {
          labelText = label.textContent.trim();
        }
      }
      
      // If no label found, check for placeholder
      if (!labelText && element.placeholder) {
        labelText = element.placeholder;
      }
      
      // If still no label, check parent element text
      if (!labelText) {
        const parent = element.parentElement;
        if (parent && parent.textContent.length < 100) {
          // Only use parent text if reasonably short
          labelText = parent.textContent.trim();
        }
      }
      
      formElements.push({
        type: element.type || element.tagName.toLowerCase(),
        name: element.name || '',
        id: element.id || '',
        label: labelText,
        options: element.tagName === 'SELECT' ? 
          Array.from(element.options).map(opt => opt.text) : 
          null,
        path: `form[${formIndex}]-${element.tagName.toLowerCase()}[${elementIndex}]`
      });
    });
    
    if (formElements.length > 0) {
      forms.push({
        action: form.action || '',
        method: form.method || 'get',
        id: form.id || '',
        elements: formElements
      });
    }
  });
  
  // If no forms found, look for form-like structures
  if (forms.length === 0) {
    // Look for divs with many input elements
    document.querySelectorAll('div').forEach((div, divIndex) => {
      const inputs = div.querySelectorAll('input, select, textarea');
      
      // Only consider divs with multiple form elements
      if (inputs.length >= 3) {
        const formElements = [];
        
        inputs.forEach((element, elementIndex) => {
          // Skip hidden fields and submit buttons
          if (element.type === 'hidden' || element.type === 'submit' || element.type === 'button') {
            return;
          }
          
          // Same label finding logic as above
          let labelText = '';
          
          if (element.id) {
            const label = document.querySelector(`label[for="${element.id}"]`);
            if (label) {
              labelText = label.textContent.trim();
            }
          }
          
          if (!labelText && element.placeholder) {
            labelText = element.placeholder;
          }
          
          if (!labelText) {
            const parent = element.parentElement;
            if (parent && parent.textContent.length < 100) {
              labelText = parent.textContent.trim();
            }
          }
          
          formElements.push({
            type: element.type || element.tagName.toLowerCase(),
            name: element.name || '',
            id: element.id || '',
            label: labelText,
            options: element.tagName === 'SELECT' ? 
              Array.from(element.options).map(opt => opt.text) : 
              null,
            path: `div[${divIndex}]-${element.tagName.toLowerCase()}[${elementIndex}]`
          });
        });
        
        if (formElements.length > 0) {
          forms.push({
            action: '',
            method: 'unknown',
            id: div.id || '',
            elements: formElements
          });
        }
      }
    });
  }
  
  return forms;
}

// Fill form with analysis results
async function fillFormWithResults() {
  if (!analysisResults || !analysisResults.fields) {
    throw new Error('No analysis results available');
  }
  
  let filledCount = 0;
  let errorCount = 0;
  
  // Process each field
  for (const field of analysisResults.fields) {
    if (!field.path || !field.recommendedValue) continue;
    
    try {
      // Parse the path to find the element
      const pathParts = field.path.split('-');
      if (pathParts.length !== 2) continue;
      
      const containerSelector = pathParts[0];
      const elementSelector = pathParts[1];
      
      // Get container index and element type/index
      let containerMatch, containerType, containerIndex;
      
      if (containerSelector.startsWith('form')) {
        containerMatch = containerSelector.match(/form\[(\d+)\]/);
        containerType = 'form';
      } else if (containerSelector.startsWith('div')) {
        containerMatch = containerSelector.match(/div\[(\d+)\]/);
        containerType = 'div';
      }
      
      if (!containerMatch) continue;
      
      containerIndex = parseInt(containerMatch[1]);
      
      const elementMatch = elementSelector.match(/(\w+)\[(\d+)\]/);
      if (!elementMatch) continue;
      
      const elementType = elementMatch[1].toLowerCase();
      const elementIndex = parseInt(elementMatch[2]);
      
      // Get the container
      const containers = document.querySelectorAll(containerType);
      if (containerIndex >= containers.length) continue;
      
      const container = containers[containerIndex];
      
      // Get the element
      const elements = container.querySelectorAll(elementType);
      if (elementIndex >= elements.length) continue;
      
      const element = elements[elementIndex];
      
      // Fill the element based on its type
      if (element.tagName === 'SELECT') {
        // For select elements, find the best matching option
        const options = Array.from(element.options);
        const value = field.recommendedValue.toLowerCase();
        
        // Try exact match first
        let matched = false;
        for (const option of options) {
          if (option.text.toLowerCase() === value) {
            element.value = option.value;
            element.dispatchEvent(new Event('change', { bubbles: true }));
            matched = true;
            filledCount++;
            break;
          }
        }
        
        // If no exact match, try partial match
        if (!matched) {
          for (const option of options) {
            if (option.text.toLowerCase().includes(value) || 
                value.includes(option.text.toLowerCase())) {
              element.value = option.value;
              element.dispatchEvent(new Event('change', { bubbles: true }));
              filledCount++;
              break;
            }
          }
        }
      } else if (element.type === 'checkbox' || element.type === 'radio') {
        // For checkboxes and radio buttons
        const value = field.recommendedValue.toLowerCase();
        if (value === 'yes' || value === 'true' || value === '1' || 
            value === 'on' || value === 'checked') {
          element.checked = true;
          element.dispatchEvent(new Event('change', { bubbles: true }));
          filledCount++;
        }
      } else {
        // For text inputs and textareas
        element.value = field.recommendedValue;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        filledCount++;
      }
    } catch (error) {
      console.error('Error filling field:', error);
      errorCount++;
    }
  }
  
  return { filledCount, errorCount };
}
