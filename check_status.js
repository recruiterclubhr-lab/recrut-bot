
// HARDCODED CREDENTIALS
const greenApiUrl = 'https://7105.api.greenapi.com';
const greenId = '7105475055';
const greenToken = 'b1a61afc4dce4282997b9a6ce386255a696b16ee244d4d36ac';

// Function to fetch data safely
async function get(method) {
    try {
        const res = await fetch(`${greenApiUrl}/waInstance${greenId}/${method}/${greenToken}`);
        return await res.json();
    } catch (e) {
        return { error: e.message };
    }
}

async function run() {
    console.log('--- Checking Green API State ---');

    // 1. Check Settings
    console.log('\n1. Settings:');
    const settings = await get('getSettings');
    console.log(JSON.stringify(settings, null, 2));

    // 2. Check State
    console.log('\n2. State:');
    const state = await get('getStateInstance');
    console.log(JSON.stringify(state, null, 2));

    // 3. Check Queue (Notification list)
    // GreenAPI stores undelivered notifications in a queue
    console.log('\n3. First 5 Notifications in Queue (Unprocessed):');
    try {
        // We can't peek the queue easily without deleting, but we can check if there are any
        // actually receiveNotification deletes it from queue if not processing it... 
        // Be careful. Let's just Receive ONE to see if it works, but NOT delete it (ack).
        // Actually best not to consume them here or the bot won't get them.

        // Just checking journal
        const journal = await fetch(`${greenApiUrl}/waInstance${greenId}/lastIncomingMessages/${greenToken}?minutes=60`);
        const journalData = await journal.json();
        console.log(`\nLast incoming messages (60 min): ${journalData.length}`);
        if (journalData.length > 0) {
            console.log('Latest message:', JSON.stringify(journalData[0], null, 2));
        }

    } catch (e) {
        console.error('Error fetching journal:', e.message);
    }
}

run();
