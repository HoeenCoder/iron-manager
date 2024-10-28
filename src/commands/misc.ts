import * as Discord from "discord.js";
import { ICommand, getGuild, Config } from "../common";
import { IronLogger } from './../logger';
import * as Luxon from 'luxon';

const commands: {[key: string]: ICommand} = {
    ping: {
        data: new Discord.SlashCommandBuilder()
            .setName('ping')
            .setDescription('Replies with pong.'),

        async execute(interaction) {
            interaction.reply({content: 'Pong!', ephemeral: true});
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
            const share = !!interaction.options.getBoolean('broadcast');
            const weekStart = IronLogger.getCurrentWeekTimestamp();
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

            interaction.reply({embeds: [embed], ephemeral: !share});
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
            const share = !!interaction.options.getBoolean('broadcast');
            let providedUser = interaction.options.getUser('member');
            if (!providedUser) providedUser = interaction.user;

            await interaction.deferReply({ephemeral: !share});

            // Get the GuildMember for this user
            const guild = await getGuild();
            if (!guild) throw new Error(`Cannot find guild, might be unavalible.`);

            const member = await guild.members.fetch(providedUser.id);
            if (!member) {
                interaction.reply({content: `:x: Member not found.`, ephemeral: true});
                return;
            }

            const records = IronLogger.readIron(member.id, IronLogger.getCurrentWeekTimestamp());

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

            interaction.followUp({embeds: [embed]});
        }
    }
};

module.exports = commands;
