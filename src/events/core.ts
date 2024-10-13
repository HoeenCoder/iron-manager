import { IEvent, commands, getGuild } from '../common';
import * as Discord from 'discord.js';
import * as Logger from '../logger';

const events: {[key: string]: IEvent} = {
    clientReady: {
        name: Discord.Events.ClientReady,
        once: true,
        async execute(client: Discord.Client) {
            console.log(`Logged in as ${client.user?.tag}.`);
        }
    },
    commandReceived: {
        name: Discord.Events.InteractionCreate,
        async execute(interaction: Discord.Interaction) {
            if (interaction.isChatInputCommand()) {
                const command = commands.get(interaction.commandName);
                if (!command) {
                    await interaction.reply({content: ':x: Command not found.', ephemeral: true});
                    Logger.logError(`Non-existant command called: ${interaction.commandName}`);
                    return;
                }

                try {
                    await command.execute(interaction);
                } catch (e) {
                    Logger.logError(e as Error);
                    if (interaction.replied || interaction.deferred) {
                        await interaction.followUp({content: `:x: An error occured while executing your command, this has been logged and will be fixed later.`,
                            ephemeral: true});
                    } else {
                        await interaction.reply({content: `:x: An error occured while executing your command, this has been logged and will be fixed later.`,
                            ephemeral: true});
                    }
                }
            } else if (interaction.isAutocomplete()) {
                const command = commands.get(interaction.commandName);
                if (!command) {
                    Logger.logError(`Autocomplete event called for non-existant command: ${interaction.commandName}`);
                    return;
                }

                if (!command.autocomplete) {
                    Logger.logError(`Autocomplete event called for command that lacks autocomplete support. ` +
                        `If this is always a bug, please make this message an error. Aborting`);
                    return;
                }

                try {
                    await command.autocomplete(interaction);
                } catch (e) {
                    Logger.logError(e as Error);
                }
            }

            // All other types ignored
        }
    }
};

module.exports = events;
