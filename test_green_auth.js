// CLEAR QUEUE SCRIPT
// Run this to stop the spam!

async function clearQueue() {
    console.log('🗑️ Starting Queue Clearing...');
    const baseUrl = process.env.GREEN_API_BASE_URL || 'https://7105.api.greenapi.com';
    const id = process.env.GREEN_API_ID_INSTANCE || '7105475055';
    const token = process.env.GREEN_API_TOKEN || 'b1a61afc4dce4282997b9a6ce386255a696b16ee244d4d36ac';

    let count = 0;
    while (true) {
        try {
            // Receive notification
            const recUrl = `${baseUrl}/waInstance${id}/receiveNotification/${token}`;
            const res = await fetch(recUrl);
            if (!res.ok) {
                console.log('No more notifications or error:', res.status);
                break;
            }
            const data = await res.json();
            if (!data || !data.receiptId) {
                console.log('Queue empty!');
                break;
            }

            // Delete notification
            const delUrl = `${baseUrl}/waInstance${id}/deleteNotification/${token}/${data.receiptId}`;
            await fetch(delUrl, { method: 'DELETE' });

            count++;
            console.log(`Deleted msg #${count} (receipt: ${data.receiptId})`);
        } catch (e) {
            console.error('Error:', e.message);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    console.log(`✅ DONE! Deleted ${count} messages.`);
}

clearQueue();
