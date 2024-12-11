import * as Discord from "discord.js";
import { getGuild, ICommand, roleBasedPermissionCheck, Config } from "../common";
import { Logger } from '../logger';

const SHIP_PREFIXES = [
    "Adjudicator", "Advocate", "Aegis", "Agent", "Arbiter", "Banner", "Beacon", "Blade", "Bringer", "Champion", "Citizen", "Claw", "Colossus",
    "Comptroller", "Courier", "Custodian", "Dawn", "Defender", "Diamond", "Distributor", "Dream", "Elected Representative", "Emperor", "Executor",
    "Eye", "Father", "Fist", "Flame", "Force", "Forerunner", "Founding Father", "Gauntlet", "Giant", "Guardian", "Halo", "Hammer", "Harbinger",
    "Herald", "Judge", "Keeper", "King", "Knight", "Lady", "Legislator", "Leviathan", "Light", "Lord", "Magistrate", "Marshal", "Martyr", "Mirror",
    "Mother", "Octagon", "Ombudsman", "Panther", "Paragon", "Patriot", "Pledge", "Power", "Precursor", "Pride", "Prince", "Princess", "Progenitor",
    "Prophet", "Protector", "Purveyor", "Queen", "Ranger", "Reign", "Representative", "Senator", "Sentinel", "Shield", "Soldier", "Song", "Soul",
    "Sovereign", "Spear", "Stallion", "Star", "Steward", "Superintendent", "Sword", "Titan", "Triumph", "Warrior", "Whisper", "Will", "Wings"
];

const SHIP_POSTFIXES = [
    "of Allegiance", "of Audacity", "of Authority", "of Battle", "of Benevolence", "of Conquest", "of Conviction", "of Conviviality", "of Courage",
    "of Dawn", "of Democracy", "of Destiny", "of Destruction", "of Determination", "of Equality", "of Eternity", "of Family Values", "of Fortitude",
    "of Freedom", "of Glory", "of Gold", "of Honor", "of Humankind", "of Independence", "of Individual Merit", "of Integrity", "of Iron", "of Judgment",
    "of Justice", "of Law", "of Liberty", "of Mercy", "of Midnight", "of Morality", "of Morning", "of Opportunity", "of Patriotism", "of Peace",
    "of Perseverance", "of Pride", "of Redemption", "of Science", "of Self-Determination", "of Selfless Service", "of Serenity", "of Starlight",
    "of Steel", "of Super Earth", "of Supremacy", "of the Constitution", "of the People", "of the Regime", "of the Stars", "of the State", "of Truth",
    "of Twilight", "of Victory", "of Vigilance", "of War", "of Wrath"
];

const PURGE_INTERVAL = 60000 * 5; // 5 minutes
const INACTIVE_DESTROYER_CHANNELS: string[] = [];
// {channelId: userId}
const CHANNEL_OWNERS: {[channelId: string]: string} = {};

setInterval(async () => {
    const guild = await getGuild();
    if (!guild || !guild.available) {
        // Something is wrong, try again later.
        Logger.logError(`Unable to find guild when attempting purge, is it unavaliable right now? Aborting.`);
        return;
    }

    const voiceCategory = await guild.channels.fetch(Config.voice_category_id);
    if (!voiceCategory) return;
    if (voiceCategory.type !== Discord.ChannelType.GuildCategory) {
        throw new Error(`When purging, voice channel category is not a category. ID: ${Config.voice_category_id}`);
    }

    for (const [channelId, channel] of voiceCategory.children.cache) {
        if (channel.type !== Discord.ChannelType.GuildVoice) continue;

        if (channel.members.size < 1) {
            if (!INACTIVE_DESTROYER_CHANNELS.includes(channel.id)) {
                // Mark for purge
                INACTIVE_DESTROYER_CHANNELS.push(channel.id);
            } else {
                // Purge
                if (!channel.deletable) {
                    Logger.logError(`Unable to delete expired voice channel "${channel.name}" ID: ${channel.id}.`);
                } else {
                    delete CHANNEL_OWNERS[channel.id];
                    await channel.delete(`Super Destroyer VC removed due to inactivity.`);
                }
            }
        } else {
            // Divers present
            if (INACTIVE_DESTROYER_CHANNELS.includes(channel.id)) {
                // Clear mark
                INACTIVE_DESTROYER_CHANNELS.splice(INACTIVE_DESTROYER_CHANNELS.indexOf(channel.id, 1));
            }
            // Do nothing else
        }
    }
}, PURGE_INTERVAL);

const commands: {[key: string]: ICommand} = {
    'create-destroyer-channel': {
        data: new Discord.SlashCommandBuilder()
            .setName('create-destroyer-channel')
            .setDescription('Create a temporary Super Destroyer voice channel that expires not long after it stops being used.')
            .addStringOption(o =>
                o.setName('prefix')
                    .setDescription(`Your Super Destroyer's prefix. Must be a valid prefix from the game. Typing will filter the list.`)
                    .setRequired(true)
                    .setAutocomplete(true))
            .addStringOption(o =>
                o.setName('postfix')
                    .setDescription(`Your Super Destroyer's postfix. Must be a valid postfix from the game. Typing will filter the list.`)
                    .setRequired(true)
                    .setAutocomplete(true)),
        async execute(interaction) {
            await interaction.deferReply({ephemeral: true});

            // 1. Validation
            const ownerIds = Object.values(CHANNEL_OWNERS);
            if (ownerIds.includes(interaction.user.id) && !roleBasedPermissionCheck('iron', interaction.member as Discord.GuildMember)) {
                await interaction.followUp({content: `:x: You already have a super destroyer VC, please use that or wait for it to expire before making a new one.`});
                return;
            }

            const prefix = interaction.options.getString('prefix') || '';
            const postfix = interaction.options.getString('postfix') || '';

            if (!SHIP_PREFIXES.includes(prefix)) {
                await interaction.followUp({content: `:x: invalid prefix "${prefix}"`});
                return;
            }

            if (!SHIP_POSTFIXES.includes(postfix)) {
                await interaction.followUp({content: `:x: invalid postfix "${postfix}"`});
                return;
            }

            const guild = await getGuild();
            if (!guild || !guild.available) {
                throw new Error(`Guild not found when creating ship voice channel!`);
            }

            // 2. Create channel
            const shipChannel = await guild.channels.create({
                parent: Config.voice_category_id,
                name: `SES ${prefix} ${postfix}`,
                reason: `Super Destroyer VC deployed upon request of ${(interaction.member as Discord.GuildMember).displayName}`,
                type: Discord.ChannelType.GuildVoice
            });

            CHANNEL_OWNERS[shipChannel.id] = interaction.user.id;

            const intervalMinutes = PURGE_INTERVAL / 60000;
            const embed = new Discord.EmbedBuilder()
                .setColor(0x3b4d33)
                .setTitle(`Super Destroyer Deployed!`)
                .setDescription(`Your Super Destroyer Voice Channel has been deployed and is ready for use!`)
                .addFields(
                    {name: `Voice Channel`, value: `<#${shipChannel.id}>`},
                    {name: `NOTICE`, value: `Super Destroyer Voice Channels expire after ${intervalMinutes} to ${intervalMinutes * 2} minutes of nobody using the channel. You can always re-create the channel if needed.`}
                );

            if (Config.thumbnail_icon_url) embed.setThumbnail(Config.thumbnail_icon_url);

            await interaction.followUp({embeds: [embed]});
        },
        async autocomplete(interaction) {
            const focusedOption = interaction.options.getFocused(true);

            let choices: string[];
            switch (focusedOption.name) {
            case 'prefix':
                choices = SHIP_PREFIXES;
                break;
            case 'postfix':
                choices = SHIP_POSTFIXES;
                break;
            default:
                // Should never happen
                throw new Error(`create ship vc command: Unexpected autocomplete field: ${focusedOption.name}`);
            }

            let enteredValue = focusedOption.value.toLowerCase();
            if (enteredValue.startsWith('of')) {
                enteredValue = enteredValue.substring(2).trim();
            }

            const response = choices.filter(v => {
                let choiceCopy = v.toLowerCase();
                if (choiceCopy.startsWith('of')) {
                    choiceCopy = choiceCopy.substring(2).trim();
                }

                // Don't trim "the" if user input equals T, or TH, or if it starts with THE
                if (choiceCopy.startsWith('the')) {
                    if (!(enteredValue === 't' ||
                        enteredValue === 'th' ||
                        enteredValue.startsWith('the'))
                    ) {
                        // We explicitly check for equality on t and th to prevent
                        // an issue where something like "the Tomato" gets filtered out
                        // if the user enters "to" (startsWith('t') would keep "the" because to starts with t)
                        choiceCopy = choiceCopy.substring(3).trim();
                    }
                }

                return choiceCopy.startsWith(enteredValue);
            }).map(v => {
                return {name: v, value: v};
            });

            await interaction.respond(response.slice(0, 24));
        },
    },
    'random-ship-name': {
        data: new Discord.SlashCommandBuilder()
            .setName('random-ship-name')
            .setDescription('Generates a random SES Super Destroyer name.')
            .addBooleanOption(o =>
                o.setName('broadcast')
                    .setDescription('Share the results of this command with everyone?')),
        async execute(interaction) {
            const share = !!interaction.options.getBoolean('broadcast');

            const embed = new Discord.EmbedBuilder()
                .setColor(0x3b4d33)
                .setTitle(`Random Super Destroyer Name`)
                .addFields(
                    {
                        name: 'Ship Name',
                        value: `SES ${SHIP_PREFIXES[Math.floor(Math.random() * SHIP_PREFIXES.length)]} ` +
                            `${SHIP_POSTFIXES[Math.floor(Math.random() * SHIP_POSTFIXES.length)]}`
                    },
                );

            await interaction.reply({embeds: [embed], ephemeral: !share});
        }
    }
};

module.exports = commands;
