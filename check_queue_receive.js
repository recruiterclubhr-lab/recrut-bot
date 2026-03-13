
// HARDCODED CREDENTIALS
const greenApiUrl = 'https://7105.api.greenapi.com';
const greenId = '7105475055';
const greenToken = 'b1a61afc4dce4282997b9a6ce386255a696b16ee244d4d36ac';

async function run() {
    console.log('--- Checking Green API Queue (Receive One) ---');
    const url = `${greenApiUrl}/waInstance${greenId}/receiveNotification/${greenToken}`;

    try {
        console.log('Fetching...');
        const res = await fetch(url);
        const data = await res.json();

        if (data && data.receiptId) {
            console.log('✅ Received Notification:');
            console.log(JSON.stringify(data, null, 2));
            console.log('\n⚠️ NOTE: This notification is now "locked" (invisible to other consumers) for a short time or until deleted.');
            console.log('If the Webhook mechanism is working, it should have already processed or failed this.');

            // Delete it to clear the queue? No, let's keep it for now unless we want to simulate processing.
            // actually if we don't delete, it comes back.
            // console.log(`To delete: deleteNotification/${greenToken}/${data.receiptId}`);
        } else {
            console.log('No notifications in queue (or queue is empty).');
            // If queue is empty but journal has messages, connection is working but webhook might have consumed them?
            // OR checks might be too fast.
        }

    } catch (e) {
        console.error('❌ Exception:', e.message);
    }
}

run();
