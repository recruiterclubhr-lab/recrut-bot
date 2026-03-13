
// HARDCODED CREDENTIALS
const greenApiUrl = 'https://7105.api.greenapi.com';
const greenId = '7105475055';
const greenToken = 'b1a61afc4dce4282997b9a6ce386255a696b16ee244d4d36ac';

async function clearQueue() {
    console.log('--- Clearing Green API Queue ---');
    const receiveUrl = `${greenApiUrl}/waInstance${greenId}/receiveNotification/${greenToken}`;

    let count = 0;
    let max = 50; // Safety limit

    while (count < max) {
        try {
            console.log(`Checking queue item ${count + 1}...`);
            const res = await fetch(receiveUrl);

            // Handle non-JSON responses (like the error we saw)
            const text = await res.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch (jsonErr) {
                console.warn(`⚠️ Received non-JSON response: ${text.slice(0, 100)}...`);
                // If it's pure text error (e.g. "Message cannot be delivered"), we might be stuck. 
                // But receiveNotification usually returns null if empty.
                // If it IS null, queue is empty.
                if (!text) {
                    console.log('✅ Queue Empty (No content).');
                    break;
                }
                // If it's an error message string but no receiptId, we can't delete it?
                // Wait, if receiveNotification errors, maybe we can't clear it this way.
                // Let's assume null means empty.
                break;
            }

            if (!data || !data.receiptId) {
                console.log('✅ Queue Empty (No receiptId).');
                break;
            }

            const receiptId = data.receiptId;
            console.log(`Processing receiptId: ${receiptId}`);

            // Delete verification
            const delUrl = `${greenApiUrl}/waInstance${greenId}/deleteNotification/${greenToken}/${receiptId}`;
            const delRes = await fetch(delUrl, { method: 'DELETE' });
            const delData = await delRes.json();

            if (delData.result) {
                console.log(`🗑️ Deleted ${receiptId}`);
            } else {
                console.error(`❌ Failed to delete ${receiptId}`);
            }

            count++;

        } catch (e) {
            console.error('❌ Loop Exception:', e.message);
            break; // Stop on critical error
        }
    }
    console.log(`\nCleared ${count} messages.`);
}

clearQueue();
