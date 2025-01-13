import * as Discord from "discord.js";
import { ICommand } from "../common";
import { IronLogger } from './../logger';

const commands: {[key: string]: ICommand} = {
    resetiron: {
        data: new Discord.SlashCommandBuilder()
            .setName('resetiron')
            .setDescription('Reset the IRON distribution JSON file - DEV MODE ONLY COMMAND')
            .setDefaultMemberPermissions(Discord.PermissionFlagsBits.Administrator),
        async execute(interaction) {
            if (!process.env.DEV_MODE) {
                await interaction.reply({content: `:x: Command only avaliable in development mode.`, flags: Discord.MessageFlags.Ephemeral});
                return;
            }
            await interaction.deferReply({flags: Discord.MessageFlags.Ephemeral});

            const key = await IronLogger.dataManager.lock();
            await IronLogger.dataManager.resetIron(key);
            await IronLogger.dataManager.unlock(key);
            await interaction.followUp({content: 'IRON JSON reset.', flags: Discord.MessageFlags.Ephemeral});
        }
    }
};

module.exports = commands;
