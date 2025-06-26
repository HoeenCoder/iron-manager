import * as Discord from "discord.js";
import { ICommand, Utilities, Config } from "../common";
import { IronLogger } from './../logger';
import * as Luxon from 'luxon';

const commands: {[key: string]: ICommand} = {
    ping: {
        data: new Discord.SlashCommandBuilder()
            .setName('ping')
            .setDescription('Replies with pong.'),

        async execute(interaction) {
            await interaction.reply({content: 'Pong!', flags: Discord.MessageFlags.Ephemeral});
        }
    },
    week: {
        data: new Discord.SlashCommandBuilder()
            .setName('week')
            .setDescription('Get the start and end time for the current week of IRON distribution.')
            .addBooleanOption(o =>
                o.setName('broadcast')
                    .setDescription('Share the results of this command with everyone?')
            ),

        async execute(interaction) {
            const replyOptions: Discord.InteractionReplyOptions =
                !interaction.options.getBoolean('broadcast') ? {flags: Discord.MessageFlags.Ephemeral} : {};
            await interaction.deferReply(replyOptions);

            const key = await IronLogger.dataManager.lock();
            const weekStart = await IronLogger.dataManager.getCurrentWeekTimestamp(key);
            await IronLogger.dataManager.unlock(key);
            const weekEnd = Luxon.DateTime.fromMillis(weekStart).plus({days: 7}).minus({seconds: 1}).toMillis();

            const embed = new Discord.EmbedBuilder()
                .setColor(0x3b4d33)
                .setTitle(`Current Week`)
                .addFields(
                    {name: 'Week Started', value: `<t:${Math.floor(weekStart / 1000)}:F>`},
                    {name: 'Week Ends on', value: `<t:${Math.floor(weekEnd / 1000)}:F>`},
                    {name: 'Week Ends in', value: `<t:${Math.floor(weekEnd / 1000)}:R>`}
                ).setTimestamp();

            if (Config.thumbnail_icon_url) embed.setThumbnail(Config.thumbnail_icon_url);

            await interaction.followUp({embeds: [embed]});
        }
    },
    earnableiron: {
        data: new Discord.SlashCommandBuilder()
            .setName('earnableiron')
            .setDescription('Check to see if you (or another member) can still earn IRON this week and how.')
            .addUserOption(o =>
                o.setName('member')
                    .setDescription('The member to check. Defaults to yourself.')
            )
            .addBooleanOption(o =>
                o.setName('broadcast')
                    .setDescription('Share the results of this command with everyone?')
            ),
        async execute(interaction) {
            const replyOptions: Discord.InteractionReplyOptions =
                !interaction.options.getBoolean('broadcast') ? {flags: Discord.MessageFlags.Ephemeral} : {};
            let providedUser = interaction.options.getUser('member');
            if (!providedUser) providedUser = interaction.user;

            await interaction.deferReply(replyOptions);

            // Get the GuildMember for this user
            const member = await Utilities.getGuildMember(providedUser.id, await Utilities.getGuild()).catch(() => null);
            if (!member) {
                await interaction.reply({content: `:x: Member not found.`, flags: Discord.MessageFlags.Ephemeral});
                return;
            }

            const key = await IronLogger.dataManager.lock();
            const records = await IronLogger.dataManager.readIron(key, member.id);
            await IronLogger.dataManager.unlock(key);

            const embed = new Discord.EmbedBuilder()
                .setColor(0x3b4d33)
                .setTitle(`IRON distributed to ${member.displayName} this week`)
                .setAuthor({name: member.displayName, iconURL: member.displayAvatarURL()})
                .setDescription(`Has ${member.displayName} earned IRON this week and how?`)
                .addFields(
                    {name: 'Deployment', value: `${records.deployment ? 'EARNED' : 'NOT EARNED'}`},
                    {name: 'Commendation', value: `${records.commendation ? 'EARNED' : 'NOT EARNED'}`}
                ).setTimestamp()
                .setFooter({text: `IRON can be earned once per category weekly. To see when a new week starts, use /week.`});

            if (Config.thumbnail_icon_url) embed.setThumbnail(Config.thumbnail_icon_url);

            await interaction.followUp({embeds: [embed]});
        }
    },
    'print-auto-promote-report': {
        data: new Discord.SlashCommandBuilder()
            .setName('print-auto-promote-report')
            .setDescription('Prints a report for IRON Manager\'s auto promotion system.')
            .setDefaultMemberPermissions(Discord.PermissionFlagsBits.Administrator),
        async execute(interaction) {
            if (!Utilities.roleBasedPermissionCheck('all', interaction.member as Discord.GuildMember)) {
                await interaction.reply({content: `:x: Access Denied. Requires one of ${Utilities.getRequiredRoleString('all')}.`, flags: Discord.MessageFlags.Ephemeral});
                return;
            }

            await interaction.deferReply({flags: Discord.MessageFlags.Ephemeral});
            let output: string[] = [];
            let currentText = `# Automatic Promotion Configuration\n-# These values can be changed by editing config.json\n\n`;

            for (let rank in Config.ranks) {
                const rankDetails = Config.ranks[rank];

                let rankSection = `## ${rank} IRON\n`;
                for (let key in rankDetails) {
                    // @ts-ignore this is clearly safe
                    const roles: string[] = rankDetails[key].slice();
                    rankSection += `- ${key}: ${roles.map(id => `<@&${id}>`).join(', ') || 'None'}\n`;
                }
                rankSection += `\n`;

                if (currentText.length + rankSection.length > 950) {
                    output.push(currentText);
                    currentText = rankSection;
                } else {
                    currentText += rankSection;
                }
            }

            output.push(currentText);

            await interaction.followUp({content: output.join(''), flags: Discord.MessageFlags.Ephemeral});
        },
    }
};

module.exports = commands;
