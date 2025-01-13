import { IEvent, commandRegistry, componentRegistry } from '../common';
import * as Discord from 'discord.js';
import { Logger, DeploymentActivityLogger } from '../logger';

const events: {[key: string]: IEvent} = {
    clientReady: {
        name: Discord.Events.ClientReady,
        once: true,
        async execute(client: Discord.Client) {
            console.log(`Logged in as ${client.user?.tag}.`);
        }
    },
    command: {
        name: Discord.Events.InteractionCreate,
        async execute(interaction: Discord.Interaction) {
            if (!interaction.isChatInputCommand()) return;

            const command = commandRegistry.get(interaction.commandName);
            if (!command) {
                await interaction.reply({content: ':x: Command not found.', flags: Discord.MessageFlags.Ephemeral});
                Logger.logError(`Non-existant command called: ${interaction.commandName}`);
                return;
            }

            try {
                await command.execute(interaction);
            } catch (e) {
                Logger.logError(e as Error);
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({content: `:x: An error occured while executing your command, this has been logged and will be fixed later.`,
                        flags: Discord.MessageFlags.Ephemeral});
                } else {
                    await interaction.reply({content: `:x: An error occured while executing your command, this has been logged and will be fixed later.`,
                        flags: Discord.MessageFlags.Ephemeral});
                }
            }
        }
    },
    autocomplete: {
        name: Discord.Events.InteractionCreate,
        async execute(interaction: Discord.Interaction) {
            if (!interaction.isAutocomplete()) return;

            const command = commandRegistry.get(interaction.commandName);
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
        },
    },
    // Buttons, string select menu changes
    componentInteract: {
        name: Discord.Events.InteractionCreate,
        async execute(interaction: Discord.Interaction) {
            if (!interaction.isButton() &&
                !interaction.isStringSelectMenu() &&
                !interaction.isModalSubmit()) return;

            const component = componentRegistry.get(interaction.customId);
            if (!component) {
                // Not all components have listeners, ignore.
                return;
            }

            try {
                await component.execute(interaction);
            } catch (e) {
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({content: `:x: An error occured while processing your request, this has been logged and will be fixed later.`,
                        flags: Discord.MessageFlags.Ephemeral});
                } else {
                    await interaction.reply({content: `:x: An error occured while processing your request, this has been logged and will be fixed later.`,
                        flags: Discord.MessageFlags.Ephemeral});
                }
                Logger.logError(e as Error);
            }
        },
    }
};

module.exports = events;
