const poller = require('./poller');
const speedingPoller = require('./speedingPoller');

const SAFETY_POLL_INTERVAL_MS = 15000;
const SPEEDING_POLL_INTERVAL_MS = 15000;

let isRunning = false;
let nextPollTimeout = null;

async function executeCoordinatedPoll() {
  if (!isRunning) return;
  
  try {
    // Execute safety poll
    await poller.executePoll();
  } catch (err) {
    console.error('[PollCoordinator] Safety poller error:', err);
  }
  
  if (!isRunning) return;
  
  // Stagger the next poll (speeding)
  nextPollTimeout = setTimeout(async () => {
    if (!isRunning) return;
    
    try {
      await speedingPoller.executePoll();
    } catch (err) {
      console.error('[PollCoordinator] Speeding poller error:', err);
    }
    
    if (!isRunning) return;
    
    // Stagger back to safety poll
    nextPollTimeout = setTimeout(executeCoordinatedPoll, SAFETY_POLL_INTERVAL_MS);
  }, SPEEDING_POLL_INTERVAL_MS);
}

function start() {
  if (isRunning) return;
  isRunning = true;
  console.log('[PollCoordinator] Starting coordinated polling cycle');
  executeCoordinatedPoll();
}

function stop() {
  isRunning = false;
  if (nextPollTimeout) {
    clearTimeout(nextPollTimeout);
    nextPollTimeout = null;
  }
  console.log('[PollCoordinator] Stopped coordinated polling cycle');
}

module.exports = {
  start,
  stop
};
