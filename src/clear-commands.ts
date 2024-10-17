const { name, version } = require('./../package.json');

// Basic enviroment checks
console.log(`[${name}@${version}] Launching in ${process.env.DEV_MODE ? `development` : `production`} enviroment.`);

const enviromentVariables = ['TOKEN', 'CLIENT_ID', 'GUILD_ID'];
for (const key of enviromentVariables) {
    const trueKey = process.env.DEV_MODE ? `DEV_${key}` : key;
    if (!process.env[trueKey]) {
        console.log(`.env not configured! Missing enviroment variable "${trueKey}"! Aborting.`);
        process.exit(1);
    }

    if (process.env.DEV_MODE) {
        // copy dev enviroment variables to main ones for ease of use
        process.env[key] = process.env[trueKey];
    }
}

import * as Discord from 'discord.js';

// Clear registered commands
(async () => {
    try {
        console.log(`Clearing registered commands...`);

        const rest = new Discord.REST().setToken(process.env.TOKEN as string);
        // Register new ones
        await rest.put(
            Discord.Routes.applicationGuildCommands(process.env.CLIENT_ID as string, process.env.GUILD_ID as string),
            {body: []}
        );

        console.log(`Commands cleared, exiting.`);
    } catch (e) {
        console.error(e);
    }
})();