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
                interaction.reply({content: `:x: Command only avaliable in development mode.`, ephemeral: true});
                return;
            }

            IronLogger.resetJSON();
            interaction.reply({content: 'IRON JSON reset.', ephemeral: true});
        }
    }
};

module.exports = commands;
