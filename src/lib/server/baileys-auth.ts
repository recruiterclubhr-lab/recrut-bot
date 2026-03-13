import { AuthenticationCreds, AuthenticationState, BufferJSON, proto, initAuthCreds } from '@whiskeysockets/baileys';
import { supabaseAdmin } from './db';

export const useSupabaseAuthState = async (sessionId: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
    const writeData = async (data: any, id: string) => {
        const { error } = await supabaseAdmin
            .from('wa_sessions')
            .upsert({ id: `${sessionId}:${id}`, data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) });
        if (error) console.error('❌ [SupabaseAuth] Save Error:', error);
    };

    const readData = async (id: string) => {
        const { data, error } = await supabaseAdmin
            .from('wa_sessions')
            .select('data')
            .eq('id', `${sessionId}:${id}`)
            .maybeSingle();

        if (error) {
            console.error('❌ [SupabaseAuth] Read Error:', error);
            return null;
        }
        return data ? JSON.parse(JSON.stringify(data.data), BufferJSON.reviver) : null;
    };

    const removeData = async (id: string) => {
        await supabaseAdmin.from('wa_sessions').delete().eq('id', `${sessionId}:${id}`);
    };

    const creds: AuthenticationCreds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type: string, ids: string[]) => {
                    const data: { [id: string]: any } = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data: any) => {
                    const tasks: Promise<void>[] = [];
                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            tasks.push(value ? writeData(value, `${type}-${id}`) : removeData(`${type}-${id}`));
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: () => writeData(creds, 'creds'),
    };
};
