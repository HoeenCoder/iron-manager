import * as Discord from "discord.js";
import { ICommand, roleBasedPermissionCheck, Config, getGuild } from "../common";
import { DeploymentActivityLogger, Logger } from './../logger';
import Luxon = require('luxon');

function generateParticipantsMessages(records: DeploymentActivityLogger.DeploymentQualificationRecord): string[] {
    const messages: string[] = [];
    let msg = '```\n**Participants:**\n';
    for (let i = 0; i < records.qualified.length; i++) {
        const toAdd = `> ${i + 1} - <@${records.qualified[i]}>\n`;
        if (msg.length + toAdd.length > 1950) {
            messages.push(msg + '```');
            msg = '```\n';
        }

        msg += toAdd;
    }

    messages.push(msg + '```');
    return messages;
}

const commands: {[key: string]: ICommand} = {
    'start-deployment': {
        data: new Discord.SlashCommandBuilder()
            .setName('start-deployment')
            .setDescription('Start tracking member playtime for a major order deployment. Requires Freedom Captain.')
            .setDefaultMemberPermissions(Discord.PermissionFlagsBits.ManageNicknames),
        async execute(interaction) {
            await interaction.deferReply({ephemeral: true});

            // 1. check permissions
            if (!roleBasedPermissionCheck('iron', interaction.member as Discord.GuildMember)) {
                await interaction.followUp({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                return;
            }

            // 2. Obtain lock, start MOD if not already.
            const key = await DeploymentActivityLogger.transactionManager.lock();
            if (DeploymentActivityLogger.transactionManager.isDeploymentActive(key)) {
                await interaction.followUp({content: `:x: Deployment is already underway.`, ephemeral: true});
            } else {
                await DeploymentActivityLogger.transactionManager.startDeployment(key);
                await interaction.followUp({content: `:white_check_mark: Deployment started!`, ephemeral: true});
                Logger.logToChannel(`Deployment started by <@${interaction.user.id}>.`);
            }
            await DeploymentActivityLogger.transactionManager.unlock(key);
        },
    },
    'end-deployment': {
        data: new Discord.SlashCommandBuilder()
            .setName('end-deployment')
            .setDescription('Stop tracking member playtime for a major order deployment. Requires Freedom Captain.')
            .setDefaultMemberPermissions(Discord.PermissionFlagsBits.ManageNicknames),
        async execute(interaction) {
            await interaction.deferReply({ephemeral: true});

            // 1. check permissions
            if (!roleBasedPermissionCheck('iron', interaction.member as Discord.GuildMember)) {
                await interaction.followUp({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                return;
            }

            // 2. Obtain lock, end MOD if not already.
            const key = await DeploymentActivityLogger.transactionManager.lock();
            if (!DeploymentActivityLogger.transactionManager.isDeploymentActive(key)) {
                await interaction.followUp({content: `:x: Deployment is not underway.`, ephemeral: true});
            } else {
                DeploymentActivityLogger.transactionManager.endDeployment(key);
                await interaction.followUp({content: `:white_check_mark: Deployment ended.`, ephemeral: true});
                Logger.logToChannel(`Deployment ended by <@${interaction.user.id}>. Generating participants list for carnage report...\n` +
                    `(Only members with at least ${Luxon.Duration.fromMillis(DeploymentActivityLogger.MINIMUM_TIME_TO_QUALIFY).as('minutes')} minutes of play time will be listed).`
                );
                const messages = generateParticipantsMessages(DeploymentActivityLogger.transactionManager.getQualifiedMembers(key));
                for (let m of messages) {
                    Logger.logToChannel(m);
                }
            }
            await DeploymentActivityLogger.transactionManager.unlock(key);
        },
    },
    'member-deployment-stats': {
        data: new Discord.SlashCommandBuilder()
            .setName('member-deployment-stats')
            .setDescription('Get playtime statistics for any member in the most recent deployment.')
            .addUserOption(o =>
                o.setName('member')
                    .setDescription('The member to get stats for, defaults to yourself'))
            .addBooleanOption(o =>
                o.setName('broadcast')
                    .setDescription('Share the results of this command with everyone?'))
            .setDefaultMemberPermissions(Discord.PermissionFlagsBits.ManageNicknames),
        async execute(interaction) {
            const share = !!interaction.options.getBoolean('broadcast');
            let providedUser = interaction.options.getUser('member');
            if (!providedUser) providedUser = interaction.user;

            await interaction.deferReply({ephemeral: !share});

            if (!roleBasedPermissionCheck('iron', interaction.member as Discord.GuildMember)) {
                await interaction.followUp({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                return;
            }

            // Get the GuildMember for this user
            const guild = await getGuild();
            if (!guild) throw new Error(`Cannot find guild, might be unavalible.`);

            const member = await guild.members.fetch(providedUser.id);
            if (!member) {
                await interaction.reply({content: `:x: Member not found.`, ephemeral: true});
                return;
            }

            const key = await DeploymentActivityLogger.transactionManager.lock();
            const record = DeploymentActivityLogger.transactionManager.getMemberData(key, member.id) || {joined: null, totalTime: 0};
            const deploymentOngoing = DeploymentActivityLogger.transactionManager.isDeploymentActive(key);
            const totalMillis = record.totalTime + (record.joined ? Date.now() - record.joined : 0);
            const totalTime = Luxon.Duration.fromMillis(totalMillis).as('minutes').toFixed(2);
            const requiredTime = Luxon.Duration.fromMillis(DeploymentActivityLogger.MINIMUM_TIME_TO_QUALIFY).as('minutes');

            const embed = new Discord.EmbedBuilder()
                .setColor(0x3b4d33)
                .setTitle(`Deployment Statistics for ${member.displayName}`)
                .setAuthor({name: member.displayName, iconURL: member.displayAvatarURL()})
                .setDescription(`${member.displayName}'s statisics for the ${deploymentOngoing ? 'current' : 'most recent'} deployment`)
                .addFields(
                    {name: 'Currently Deployed?', value: `${deploymentOngoing ? (record.joined ? 'Yes' : 'No') : 'No Active Deployment'}`},
                    {name: 'Playtime', value: `${totalTime} minutes of ${requiredTime} required minutes`}
                ).setTimestamp()
                .setFooter({text: `The information shown is from the ${deploymentOngoing ? 'current' : 'most recent'} Major Order Deployment.`});

            if (Config.thumbnail_icon_url) embed.setThumbnail(Config.thumbnail_icon_url);

            await interaction.followUp({embeds: [embed], ephemeral: !share});

            await DeploymentActivityLogger.transactionManager.unlock(key);
        },
    },
    'generate-participants-message': {
        data: new Discord.SlashCommandBuilder()
            .setName('generate-participants-message')
            .setDescription('Generate the participants section of the carnage report based on deployment records.')
            .setDefaultMemberPermissions(Discord.PermissionFlagsBits.ManageNicknames),
        async execute(interaction) {
            await interaction.deferReply({ephemeral: true});

            // 1. check permissions
            if (!roleBasedPermissionCheck('iron', interaction.member as Discord.GuildMember)) {
                await interaction.followUp({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                return;
            }

            // 2. Obtain lock, print report.
            const key = await DeploymentActivityLogger.transactionManager.lock();

            const messages = generateParticipantsMessages(DeploymentActivityLogger.transactionManager.getQualifiedMembers(key));
            for (let m of messages) {
                await interaction.followUp({content: m, ephemeral: true});
            }

            if (DeploymentActivityLogger.transactionManager.isDeploymentActive(key)) {
                await interaction.followUp({content: `:warning: **Warning! Deployment is still ongoing, this list is subject to change!** ` +
                    `If you want to end the deployment, use /end-deployment.`, ephemeral: true});
            }

            await DeploymentActivityLogger.transactionManager.unlock(key);
        },
    }
};

module.exports = commands;
