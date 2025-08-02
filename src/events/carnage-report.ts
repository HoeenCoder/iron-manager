import { IEvent, Config, Utilities } from '../common';
import * as Discord from 'discord.js';
import { distributeIron, IronDistributionResults } from '../iron-manager';
import { Logger } from '../logger';

const events: {[key: string]: IEvent} = {
    watchForReport: {
        name: Discord.Events.MessageCreate,
        async execute(message: Discord.Message) {
            // 1. Validate
            if (!Config.report_channel_id || message.channelId !== Config.report_channel_id) return;

            const guild = message.guild;
            if (!guild) {
                // Silently return
                return;
            }

            const matches = [...message.content.matchAll(/[0-9]+ *- *<@([0-9]+)> *$/gm)].map(v => v[1]);
            if (!matches.length) return;

            // 2. Prepare
            const members: Discord.GuildMember[] = [];
            for (const id of matches) {
                const member = await Utilities.getGuildMember(id, guild).catch(() => null);
                if (!member) {
                    // Can't find member, skip
                    continue;
                }
                members.push(member);
            }

            // 3. Distribute
            let report = await distributeIron(members, 'deployment');

            // 4. Report
            const author = await guild.members.fetch(message.author.id);
            const reportEmbed = new Discord.EmbedBuilder()
                .setColor(0x3b4d33)
                .setTitle(`IRON Distribution Report`)
                .setDescription(`IRON distributed for deployment. Automatically generated from carnage report ${message.url}.`)
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

            Logger.logEmbedToChannel(reportEmbed);
        }
    }
};

module.exports = events;
