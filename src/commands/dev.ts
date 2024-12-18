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
                await interaction.reply({content: `:x: Command only avaliable in development mode.`, ephemeral: true});
                return;
            }
            await interaction.deferReply({ephemeral: true});

            const key = await IronLogger.transactionManager.lock();
            await IronLogger.transactionManager.resetIron(key);
            await IronLogger.transactionManager.unlock(key);
            await interaction.followUp({content: 'IRON JSON reset.', ephemeral: true});
        }
    }
};

module.exports = commands;
