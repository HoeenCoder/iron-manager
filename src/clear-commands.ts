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
