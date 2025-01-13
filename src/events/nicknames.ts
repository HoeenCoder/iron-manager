import { IEvent } from '../common';
import * as Discord from 'discord.js';
import { Logger } from '../logger';
import { Config } from '../common';
import { recentlyUpdatedNames } from '../iron-manager';

const events: {[key: string]: IEvent} = {
    nickname_monitor: {
        name: Discord.Events.GuildMemberUpdate,
        async execute(oldMember: Discord.PartialGuildMember, newMember: Discord.GuildMember) {
            if (oldMember.displayName === newMember.displayName) return;

            // Ignore newly added members
            if (newMember.displayName.trim().startsWith('[ 0 ]') && !oldMember.displayName.trim().startsWith('[')) return;

            // Ignore recent bot updates
            if (recentlyUpdatedNames.includes(newMember.id)) return;

            // Nickname changed, log
            const embed = new Discord.EmbedBuilder()
                .setColor(0x3b4d33)
                .setTitle(`Nickname Change Detected`)
                .setAuthor({name: newMember.displayName, iconURL: newMember.displayAvatarURL()})
                .setDescription(`IRON Manager has detected that a user's nickname was changed, possibly illegally.`)
                .addFields(
                    {name: 'Old Name', value: oldMember.displayName},
                    {name: 'New Value', value: newMember.displayName}
                )
                .setTimestamp()
                .setFooter({text: 'Remember that IRON is stored in usernames, the bot doesn\'t track IRON counts itself.'});

            if (Config.thumbnail_icon_url) embed.setThumbnail(Config.thumbnail_icon_url);

            Logger.logEmbedToChannel(embed);
        }
    }
};

module.exports = events;
