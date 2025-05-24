const { name, version } = require('./../package.json');

// Basic enviroment checks
console.log(`[${name}@${version}] Launching in ${process.env.DEV_MODE ? `development` : `production`} enviroment.`);

const enviromentVariables = ['DEV_MODE', 'TOKEN', 'CLIENT_ID', 'GUILD_ID'];
for (const key of enviromentVariables) {
    if (!process.env[key]) {
        console.log(`Enviroment variable not configured! Missing "${key}"! Aborting.`);
        process.exit(1);
    }
}

import * as Discord from 'discord.js';
import fs = require('fs');
import { ICommand, IEvent, commandRegistry, componentRegistry } from './common';
import { Logger } from './logger';

// Initialize client
export const client = new Discord.Client({ intents: [
    // ensures that discord.js's internal caches are populated
    Discord.GatewayIntentBits.Guilds,
    // allows the bot to read messages
    Discord.GatewayIntentBits.GuildMessages,
    Discord.GatewayIntentBits.MessageContent,
    // allows the bot to manage member nicknames
    Discord.GatewayIntentBits.GuildMembers,
    // allows the bot to see users in voice channels
    Discord.GatewayIntentBits.GuildVoiceStates
]});

// Load commands
const ext = __filename.endsWith('ts') ? 'ts' : 'js'; // Handle differences between dev and production
let commandData: Discord.RESTPostAPIChatInputApplicationCommandsJSONBody[] = [];
const commandFiles = fs.readdirSync(`${__dirname}/commands`).filter(f => f.endsWith(ext));
for (const file of commandFiles) {
    if (file === 'dev.js') {
        if (!process.env.DEV_MODE) {
            // Dangerous commands we don't want loaded or registered in production
            continue;
        } else {
            console.log(`[NOTICE] Loading development commands...`);
        }
    }
    const commandModule: {[key: string]: ICommand} = require(`${__dirname}/commands/${file}`);
    for (let c in commandModule) {
        const command = commandModule[c];
        commandRegistry.set(c, command);

        if (command.components) {
            for (const id in command.components) {
                componentRegistry.set(id, command.components[id]);
            }
        }

        commandData.push(command.data.toJSON());
    }
}

// Load events
const eventFiles = fs.readdirSync(`${__dirname}/events`).filter(f => f.endsWith(ext));
for (const file of eventFiles) {
    if (file === 'dev.js') {
        if (!process.env.DEV_MODE) {
            // Dev specific events we don't want loaded in production
            continue;
        } else {
            console.log(`[NOTICE] Loading development events...`);
        }
    }
    const eventModule: {[key: string]: IEvent} = require(`${__dirname}/events/${file}`);
    for (let event of Object.values(eventModule)) {
        if (event.once) {
            client.once(event.name, event.execute);
        } else {
            client.on(event.name, event.execute);
        }
    }
}

// Register commands
(async () => {
    try {
        console.log(`Registering commands...`);

        const rest = new Discord.REST().setToken(process.env.TOKEN as string);
        // Register new ones
        await rest.put(
            Discord.Routes.applicationGuildCommands(process.env.CLIENT_ID as string, process.env.GUILD_ID as string),
            {body: commandData}
        );

        console.log(`Commands registered.`);
    } catch (e) {
        Logger.logError(e as Error);
    }
})();

process.on('uncaughtException', e => {
    Logger.logError(e);
    process.exit(1);
});

process.on('unhandledRejection', e => {
    Logger.logError(e as Error);
    process.exit(1);
});

// Login
client.login(process.env.TOKEN);
