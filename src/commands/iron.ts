import * as Discord from "discord.js";
import { ICommand, Utilities, Config } from "../common";
import { Logger, IronLogger } from './../logger';
import { distributeIron, IronDistributionResults } from './../iron-manager';

const commands: {[key: string]: ICommand} = {
    'add-iron': {
        data: new Discord.SlashCommandBuilder()
            .setName('add-iron')
            .setDescription('Distributes IRON to the provided users either for attending a deployment or being commended.')
            .addStringOption(o =>
                o.setName('type')
                    .setDescription('Are you awarding IRON for a deployment or commendation?')
                    .setRequired(true)
                    .addChoices(
                        {name: 'Deployment', value: 'deployment'},
                        {name: 'Commendation', value: 'commendation'}
                    ))
            .addStringOption(o =>
                o.setName('members')
                    .setDescription('The mentions (@s) of the members to award IRON to.')
                    .setRequired(true))
            .setDefaultMemberPermissions(Discord.PermissionFlagsBits.MoveMembers),
        async execute(interaction) {
            await interaction.deferReply({flags: Discord.MessageFlags.Ephemeral});

            // 1. check permissions
            // Should be enforced by discord, verify it actually was
            const type: IronLogger.IronAchivementType = interaction.options.getString('type') as IronLogger.IronAchivementType;
            if (!['deployment', 'commendation'].includes(type)) {
                await Utilities.reply(interaction, {content: `:x: Type must be "deployment" or "commendation".`, flags: Discord.MessageFlags.Ephemeral});
                return;
            }

            if (type === "deployment") {
                // Deployment IRON requires freedom captain+
                if (!Utilities.roleBasedPermissionCheck('iron', interaction.member as Discord.GuildMember)) {
                    await Utilities.reply(interaction, {content: `:x: Access Denied. Requires one of ${Utilities.getRequiredRoleString('iron')}.`, flags: Discord.MessageFlags.Ephemeral});
                    return;
                }
            } else {
                // Commendation IRON required IRON commission+
                if (!Utilities.roleBasedPermissionCheck('all', interaction.member as Discord.GuildMember)) {
                    await Utilities.reply(interaction, {content: `:x: Access Denied. Requires one of ${Utilities.getRequiredRoleString('all')}.`, flags: Discord.MessageFlags.Ephemeral});
                    return;
                }
            }

            // 2. validate arguments
            // Type is already validated as it was needed for perm checks

            // Could be anything, make sure its user mentions
            const input = interaction.options.getString('members');
            const matches = [...(input || '').matchAll(/<@([0-9]+)>/g)].map(v => v[1]);
            if (!input || !matches || !matches.length) {
                await Utilities.reply(interaction, {content: `:x: No members provided.`, flags: Discord.MessageFlags.Ephemeral});
                return;
            }

            // Convert to GuildMembers
            const guild = await Utilities.getGuild(interaction);
            const members: Discord.GuildMember[] = [];
            for (const id of matches) {
                let member = await Utilities.getGuildMember(id, guild).catch(() => null);
                if (!member) {
                    // Can't find them, skip.
                    continue;
                }
                members.push(member);
            }

            // 3. execute distribution
            let report = await distributeIron(members, type);

            // 4. report results
            const author = await guild.members.fetch(interaction.user.id);
            const reportEmbed = new Discord.EmbedBuilder()
                .setColor(0x3b4d33)
                .setTitle(`IRON Distribution Report`)
                .setDescription(`IRON distributed for ${type}.`)
                .setAuthor({name: author.displayName, iconURL: author.displayAvatarURL()})
                .setTimestamp()
                .setFooter({text: 'For an explanation of this report, use /explainironreport.'});

            const fieldTitles = {
                'issued': 'Iron Issued',
                'notIssued': 'Iron Already Earned',
                'duplicates': 'Duplicates',
                'invalidName': 'Invalid Nickname',
                'namePermsError': 'Nickname Permissions Error',
                'rankPermsError': 'Promotion Permissions Error',
                'skippedEnvoys': 'Skipped Envoys',
                'commendedForService': 'Commendation Issued for 5 MODs'
            };

            for (const key in report) {
                const members = report[key as keyof IronDistributionResults];
                let i = 1;
                let fieldText = '';

                for (const m of members) {
                    let toAdd: string;
                    if (Array.isArray(m)) {
                        toAdd = `(${m[1]} -> <@${m[0].id}>)`;
                    } else {
                        toAdd = `<@${m.id}> `;
                    }

                    if (fieldText.length + toAdd.length > 1024) {
                        // @ts-ignore this is safe
                        const title: string = i > 1 ? `${fieldTitles[key]} ${i}` : fieldTitles[key];

                        reportEmbed.addFields({
                            name: title,
                            value: fieldText
                        });

                        // Increment title tracker, clear field value
                        i++;
                        fieldText = '';
                    }

                    fieldText += toAdd;
                }

                if (fieldText.length > 0 || i === 1) {
                    // @ts-ignore this is safe
                    const title: string = i > 1 ? `${fieldTitles[key]} ${i}` : fieldTitles[key];

                    reportEmbed.addFields({
                        name: title,
                        value: fieldText || 'None'
                    });
                }
            }

            if (Config.thumbnail_icon_url) reportEmbed.setThumbnail(Config.thumbnail_icon_url);

            await Utilities.reply(interaction, {
                embeds: [reportEmbed],
                flags: Discord.MessageFlags.Ephemeral
            });

            await Logger.logEmbedToChannel(reportEmbed);
        }
    },
    explainironreport: {
        data: new Discord.SlashCommandBuilder()
            .setName('explainironreport')
            .setDescription('Print an explanation of the IRON distribution report.')
            .addBooleanOption(o =>
                o.setName('broadcast')
                    .setDescription('Share the results of this command with everyone?'))
            .setDefaultMemberPermissions(Discord.PermissionFlagsBits.MoveMembers),

        async execute(interaction) {
            const replyOptions: Discord.InteractionReplyOptions =
                !interaction.options.getBoolean('broadcast') ? {flags: Discord.MessageFlags.Ephemeral} : {};
            await interaction.deferReply(replyOptions);

            // check permissions
            if (!Utilities.roleBasedPermissionCheck('iron', interaction.member as Discord.GuildMember)) {
                await Utilities.reply(interaction, {content: `:x: Access Denied. Requires one of ${Utilities.getRequiredRoleString('iron')}.`});
                return;
            }

            const embed = new Discord.EmbedBuilder()
                .setColor(0x3b4d33)
                .setTitle(`IRON Distribution Report Explanation`)
                .setDescription(`An explanation of the values in the IRON distribution report.`)
                .addFields(
                    {name: 'Iron Issued', value: `IRON was sucessfully issued to this member. No further action is required.`},
                    {name: 'Iron Aready Earned', value: `This member already received IRON this week for the category you tried to award IRON in. ` + 
                        `IRON was not issued. This can be overriden by manually updating their username and roles as needed`},
                    {name: 'Duplicates', value: `This member was listed twice in the list of members to issue IRON to. ` + 
                        `They will appear in another category too. They will not be given duplicate IRON.`},
                    {name: 'Invalid nickname', value: `The bot could not understand this member's nickname. Please fix their username so it is in the standard ` +
                        `format of \`[ NUMERALS ] USERNAME\` and try issuing them IRON again with the /addiron command.`},
                    {name: 'Nickname Permissions Error', value: `The bot was unable to update this member's nickname to give them IRON because this member ` +
                        `has a role higher than the bot's highest role. Please manually update this member's nickname and roles if required. ` + 
                        `The member's intended IRON count will be listed before the name eg: \`(VI -> @member)\` means that member should have 6 IRON now. ` +
                        `The bot has recorded that this member received IRON even though it encountered an error when issuing it.`},
                    {name: 'Promotion Permissions Error', value: `The bot was unable to update this member's roles after giving them IRON because the role(s) ` +
                        `tried to assign are above the bot's highest role or do not exist. Please manually update this member's roles.`},
                    {name: `Skipped Envoys`, value: `Envoys cannot earn IRON, the bot will always skip awarding IRON to them.`},
                    {name: 'Commendation Issued for 5 MODs', value: `Members who participate in 5+ MODs in a week will receive an automatic commendation unless they ` +
                        `received one through other means already this week. Those who were issued an extra IRON in this report are listed here. Please note they will ` +
                        `also appear in another category too.`}
                );

            if (Config.thumbnail_icon_url) embed.setThumbnail(Config.thumbnail_icon_url);

            await Utilities.reply(interaction, {embeds: [embed]});
        }
    }
};

module.exports = commands;
