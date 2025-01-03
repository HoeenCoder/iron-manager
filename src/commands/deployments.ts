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
            await interaction.deferReply({flags: Discord.MessageFlags.Ephemeral});

            // 1. check permissions
            if (!roleBasedPermissionCheck('iron', interaction.member as Discord.GuildMember)) {
                await interaction.followUp({content: `:x: Access Denied. Requires Freedom Captain permissions.`, flags: Discord.MessageFlags.Ephemeral});
                return;
            }

            // 2. Obtain lock, start MOD if not already.
            const key = await DeploymentActivityLogger.transactionManager.lock();
            if (DeploymentActivityLogger.transactionManager.isDeploymentActive(key)) {
                await interaction.followUp({content: `:x: Deployment is already underway.`, flags: Discord.MessageFlags.Ephemeral});
            } else {
                await DeploymentActivityLogger.transactionManager.startDeployment(key);
                await interaction.followUp({content: `:white_check_mark: Deployment started!`, flags: Discord.MessageFlags.Ephemeral});
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
            await interaction.deferReply({flags: Discord.MessageFlags.Ephemeral});

            // 1. check permissions
            if (!roleBasedPermissionCheck('iron', interaction.member as Discord.GuildMember)) {
                await interaction.followUp({content: `:x: Access Denied. Requires Freedom Captain permissions.`, flags: Discord.MessageFlags.Ephemeral});
                return;
            }

            // 2. Obtain lock, end MOD if not already.
            const key = await DeploymentActivityLogger.transactionManager.lock();
            if (!DeploymentActivityLogger.transactionManager.isDeploymentActive(key)) {
                await interaction.followUp({content: `:x: Deployment is not underway.`, flags: Discord.MessageFlags.Ephemeral});
            } else {
                DeploymentActivityLogger.transactionManager.endDeployment(key);
                await interaction.followUp({content: `:white_check_mark: Deployment ended.`, flags: Discord.MessageFlags.Ephemeral});
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
            const replyOptions: Discord.InteractionReplyOptions =
                interaction.options.getBoolean('broadcast') ? {flags: Discord.MessageFlags.Ephemeral} : {};
            let providedUser = interaction.options.getUser('member');
            if (!providedUser) providedUser = interaction.user;

            await interaction.deferReply(replyOptions);

            if (!roleBasedPermissionCheck('iron', interaction.member as Discord.GuildMember)) {
                await interaction.followUp({content: `:x: Access Denied. Requires Freedom Captain permissions.`});
                return;
            }

            // Get the GuildMember for this user
            const guild = await getGuild();
            if (!guild) throw new Error(`Cannot find guild, might be unavalible.`);

            const member = await guild.members.fetch(providedUser.id);
            if (!member) {
                await interaction.reply({content: `:x: Member not found.`});
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

            await interaction.followUp({embeds: [embed]});

            await DeploymentActivityLogger.transactionManager.unlock(key);
        },
    },
    'generate-participants-message': {
        data: new Discord.SlashCommandBuilder()
            .setName('generate-participants-message')
            .setDescription('Generate the participants section of the carnage report based on deployment records.')
            .setDefaultMemberPermissions(Discord.PermissionFlagsBits.ManageNicknames),
        async execute(interaction) {
            await interaction.deferReply({flags: Discord.MessageFlags.Ephemeral});

            // 1. check permissions
            if (!roleBasedPermissionCheck('iron', interaction.member as Discord.GuildMember)) {
                await interaction.followUp({content: `:x: Access Denied. Requires Freedom Captain permissions.`, flags: Discord.MessageFlags.Ephemeral});
                return;
            }

            // 2. Obtain lock, print report.
            const key = await DeploymentActivityLogger.transactionManager.lock();

            const messages = generateParticipantsMessages(DeploymentActivityLogger.transactionManager.getQualifiedMembers(key));
            for (let m of messages) {
                await interaction.followUp({content: m, flags: Discord.MessageFlags.Ephemeral});
            }

            if (DeploymentActivityLogger.transactionManager.isDeploymentActive(key)) {
                await interaction.followUp({content: `:warning: **Warning! Deployment is still ongoing, this list is subject to change!** ` +
                    `If you want to end the deployment, use /end-deployment.`, flags: Discord.MessageFlags.Ephemeral});
            }

            await DeploymentActivityLogger.transactionManager.unlock(key);
        },
    },
    'get-deployment-logs': {
        data: new Discord.SlashCommandBuilder()
            .setName('get-deployment-logs')
            .setDescription('Get logs from a past deployment.')
            .addStringOption(o =>
                o.setName('file')
                    .setDescription('Logs names are the timestamp of when the MOD started. YYYY-MM-DDTHH-MM-SS.log')
                    .setRequired(true)
                    .setAutocomplete(true))
            .setDefaultMemberPermissions(Discord.PermissionFlagsBits.ManageNicknames),
        async execute(interaction) {
            if (!roleBasedPermissionCheck('iron', interaction.member as Discord.GuildMember)) {
                await interaction.reply({content: `:x: Access Denied. Requires Freedom Captain permissions.`, flags: Discord.MessageFlags.Ephemeral});
                return;
            }

            const file = interaction.options.getString('file') || '';
            const validFiles = DeploymentActivityLogger.transactionManager.getLogFileNames();
            if (!validFiles.includes(file)) {
                await interaction.reply({content: `:x: invalid file name "${file}"`, flags: Discord.MessageFlags.Ephemeral});
                return;
            }

            if (!interaction.channel || !interaction.channel.isSendable()) {
                await interaction.reply({content: ':x: You must use this command in a text channel.', flags: Discord.MessageFlags.Ephemeral});
                return;
            }

            // send file
            await interaction.reply({
                content: `Deployment log file attached. You can search for members by their unique discord ID: https://www.reddit.com/r/discordapp/comments/myncgd/comment/gvvysmj/`,
                files: [{
                    attachment: DeploymentActivityLogger.transactionManager.getFullLogFilePath(file),
                    name: `${file}`
                }],
                flags: Discord.MessageFlags.Ephemeral
            });
        },
        async autocomplete(interaction) {
            if (!roleBasedPermissionCheck('iron', interaction.member as Discord.GuildMember)) {
                // Those who do not have permission do not see the options.
                await interaction.respond([]);
                return;
            }

            const focusedOption = interaction.options.getFocused(true);

            const options = DeploymentActivityLogger.transactionManager.getLogFileNames()
                .filter(f => f.startsWith(focusedOption.value))
                .sort((a, b) => {
                    const partsA = ([] as number[]).concat(...a.slice(0, -4).split('T').map(p => p.split('-').map(Number)));
                    const partsB = ([] as number[]).concat(...b.slice(0, -4).split('T').map(p => p.split('-').map(Number)));
                    for (let i = 0; i < partsA.length; i++) {
                        if (partsA[i] !== partsB[i]) {
                            return partsB[i] - partsA[i];
                        }
                    }
                    return 0; // Identical
                }).map(v => {
                    return {name: v, value: v};
                });

            await interaction.respond(options.slice(0, 24));
        }
    }
};

module.exports = commands;
