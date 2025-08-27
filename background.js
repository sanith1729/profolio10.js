// background.js
// Function to extract token from localStorage
function getLocalStorageToken() {
  return localStorage.getItem('token');
}

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'checkAuth') {
    // We need to execute a script in the current tab to access its localStorage
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (!tabs[0]) {
        sendResponse({isLoggedIn: false, error: 'No active tab'});
        return;
      }
      
      // Check if we're on Profolio domain
      const url = new URL(tabs[0].url);
      const isProfolioSite = url.hostname.includes('profolio.com'); // Change to your domain
      
      if (!isProfolioSite) {
        // Check if we have cached user data
        chrome.storage.local.get(['userData', 'authTimestamp'], (result) => {
          // Check if data is still valid (less than 1 hour old)
          const isValid = result.authTimestamp && 
                          (Date.now() - result.authTimestamp < 3600000);
          
          if (isValid && result.userData) {
            sendResponse({
              isLoggedIn: true,
              userData: result.userData
            });
          } else {
            sendResponse({isLoggedIn: false});
          }
        });
        return;
      }
      
      // Execute script in the Profolio tab to get localStorage token
      chrome.scripting.executeScript({
        target: {tabId: tabs[0].id},
        function: getLocalStorageToken
      }, (results) => {
        const token = results[0]?.result;
        
        if (token) {
          // Make a request to your API to verify the token and get user data
          fetch('https://profolio.com/api/auth/profile', { // Change to your API endpoint
            headers: {
              'Authorization': `Bearer ${token}`
            }
          })
          .then(response => response.json())
          .then(data => {
            if (data.user) {
              // Cache the user data
              chrome.storage.local.set({
                userData: data.user,
                authTimestamp: Date.now()
              });
              
              sendResponse({
                isLoggedIn: true,
                userData: data.user
              });
            } else {
              sendResponse({isLoggedIn: false});
            }
          })
          .catch(error => {
            console.error('Auth check error:', error);
            sendResponse({isLoggedIn: false, error: error.message});
          });
        } else {
          sendResponse({isLoggedIn: false});
        }
      });
    });
    
    return true; // Required for async sendResponse
  }
  
  if (message.action === 'analyzeForm') {
    // Get cached user data and make API call
    chrome.storage.local.get(['userData'], (result) => {
      if (!result.userData) {
        sendResponse({success: false, error: 'Not logged in'});
        return;
      }
      
      // Call your API to analyze the form
      fetch('https://profolio.com/api/assistant/analyze', { // Change to your API endpoint
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          userId: result.userData.id,
          formData: message.formData,
          screenshot: message.screenshot
        })
      })
      .then(response => response.json())
      .then(data => {
        if (data.success) {
          sendResponse({success: true, analysis: data.analysis});
        } else {
          sendResponse({success: false, error: data.error});
        }
      })
      .catch(error => {
        console.error('Analysis error:', error);
        sendResponse({success: false, error: error.message});
      });
    });
    
    return true; // Required for async sendResponse
  }
});
