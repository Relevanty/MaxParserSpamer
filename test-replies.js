import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { validateEnv } from "./src/auth.js";
import "dotenv/config";

async function test() {
    const { apiId, apiHash } = validateEnv();
    const stringSession = new StringSession(process.env.SESSION_STRING || "");
    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await client.connect();

    // Let's get a channel
    const dialogs = await client.getDialogs({ limit: 10 });
    const channel = dialogs.find(d => d.isChannel && d.entity.broadcast);
    
    if (!channel) {
        console.log("No channel found");
        process.exit(0);
    }

    console.log("Testing on channel", channel.title);
    
    // Find a post with comments
    let postWithComments = null;
    for await (const msg of client.iterMessages(channel.entity, { limit: 50 })) {
        if (msg.replies && msg.replies.replies > 0) {
            postWithComments = msg;
            break;
        }
    }

    if (!postWithComments) {
        console.log("No posts with comments found");
        process.exit(0);
    }

    console.log("Found post with", postWithComments.replies.replies, "comments");

    try {
        let count = 0;
        for await (const reply of client.iterMessages(channel.entity, { replyTo: postWithComments.id, limit: 10 })) {
            count++;
            console.log("Reply", count, "from", reply.senderId);
        }
        console.log("iterMessages replyTo worked, found", count, "replies");
    } catch (e) {
        console.error("iterMessages failed", e);
    }
    
    process.exit(0);
}

test();
