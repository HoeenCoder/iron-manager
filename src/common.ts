/**
 * Contains commonly used identifiers.
 */

import * as Discord from "discord.js";
import fs = require('fs');
import { client } from "./main";

/**
 * Contains useful static methods used throughout the bot.
 */
export class Utilities {
    private static deprecationWarningIssued = false;
    static getFileName(fileName: string): string {
        if (process.env.DEV_MODE) {
            return fileName + '-dev';
        }
        return fileName;
    }

    /**
     * Replies to an interaction. This wrapper ensures the interaction is not expired and
     * handles followup replies to reduce errors when responding to commands.
     * @param interaction The interaction to respond to.
     * @param payload The payload to respond with. Same arguments are used here as when replying to an interaction normally.
     */
    public static async reply(interaction: Discord.CommandInteraction | Discord.ButtonInteraction | Discord.StringSelectMenuInteraction | Discord.ModalSubmitInteraction,
            payload: string | Discord.MessagePayload | Discord.InteractionReplyOptions) {
        // Actual limits are 15 minutes/3 seconds, we cut off 300ms to give the message time to transmit
        const timeLimit = (interaction.deferred || interaction.replied ? 1000 * 60 * 15 : 1000 * 3) - 300;
        if (interaction.createdTimestamp + timeLimit <= Date.now()) {
            throw new Error(`Attempted to reply to expired interaction (Time Limit: ${timeLimit}) (${interaction.isCommand() ?
                'command: ' + interaction.command?.name : 'component: ' + interaction.customId})`);
        }

        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(payload);
        } else {
            await interaction.reply(payload);
        }
    }

    /**
     * Determine if a member can perform the requested action.
     * @param permissionKey The specific category of action being taken.
     * Each key is associated with an array of roles that can perform those tasks in config.json.
     * @param member The member taking the action.
     * @returns a boolean indicating if the action is permitted.
     */
    static roleBasedPermissionCheck(permissionKey: string, member: Discord.GuildMember): boolean {
        const allAccessRoles: string[] = Config.permissions['all'] || [];

        if (!(permissionKey in Config.permissions)) {
            if (!allAccessRoles || !allAccessRoles.length) {
                console.log(`Permissions not configred! Please configure permissions in config.json!`);
                return false; // Perms not configured
            }
            permissionKey = 'all'; // default to global permission
        }

        let eligibleRoles = Config.permissions[permissionKey];
        if (permissionKey !== 'all') {
            eligibleRoles = eligibleRoles.concat(allAccessRoles);
        }

        const roles = member.roles.cache;

        for (const role of eligibleRoles) {
            if (roles.has(role)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get a string containing all roles that are permitted to perform the specified action.
     * @param permissionKey permissionKey The specific category of action being taken.
     * Each key is associated with an array of roles that can perform those tasks in config.json.
     * @returns a string containing role mentions.
     */
    static getRequiredRoleString(permissionKey: string): string {
        if (!(permissionKey in Config.permissions)) {
            // If no valid key is found, return an error message.
            return `ERROR: Bad Permissions Key`;
        }

        const allAccessRoles: string[] = Config.permissions['all'] || [];
        let eligibleRoles = Config.permissions[permissionKey];
        if (permissionKey !== 'all') {
            eligibleRoles = eligibleRoles.concat(allAccessRoles);
        }

        return eligibleRoles.map(rid => `<@&${rid}>`).join(", ");
    }

    /**
     * Get the guild specified by the guildId. If not provided. defaults to the bot's main guild.
     * The guildId argument will be MANDATORY in the future as support for multiple servers is added.
     * @param guildId The guild to get, defaults to the bot's main guild.
     * @returns The requested guild or (deprecated) the default one.
     * @throws An error if the guild isn't found or isn't avaliable.
     * If you don't want an error as a result, I recommend appending this call with .catch(() => null);
     */
    static async getGuild(guildId?: string | Discord.BaseInteraction): Promise<Discord.Guild> {
        if (!guildId) {
            // Depreciation warning
            if (!Utilities.deprecationWarningIssued) {
                process.emitWarning('Utilities.getGuild will require a guildId as an argument in the future.');
                Utilities.deprecationWarningIssued = true;
            }
            guildId = process.env.GUILD_ID as string;
        }

        if (guildId instanceof Discord.BaseInteraction) {
            guildId = guildId.guildId || '';
        }

        const guild = await client.guilds.fetch(guildId as string);
        if (!guild || !guild.available) {
            throw new Error(`Guild "${guildId}" is unavaliable or does not exist.`);
        }
        return guild;
    }

    /**
     * Get a channel from a guild.
     * @param channelId The channel to get.
     * @param guild The guild the channel is a part of.
     * @returns The requested channel.
     * @throws An error if the channel is not found.
     * If you don't want an error as a result, I recommend appending this call with .catch(() => null);
     */
    static async getGuildChannel(channelId: string, guild: Discord.Guild): Promise<Discord.GuildBasedChannel> {
        const channel = await guild.channels.fetch(channelId);
        if (!channel) {
            throw new Error(`Channel "${channelId}" not found in guild with ID "${guild.id}".`);
        }
        return channel;
    }

    /**
     * Get a message from a channel by ID.
     * @param messageId ID of the message to get.
     * @param channel Channel the message is a part of.
     * @returns The message.
     * @throws An error if the channel is not text based (has no messages) or if the message is not found.
     * If you don't want an error as a result, I recommend appending this call with .catch(() => null);
     */
    static async getGuildMessage(messageId: string, channel: Discord.GuildBasedChannel): Promise<Discord.Message> {
        if (!channel.isTextBased()) {
            throw new Error(`Channel "${channel.id}" is not text based, cannot get message.`);
        }

        const message = await channel.messages.fetch(messageId);
        if (!message) {
            throw new Error(`Message "${messageId}" not found in channel with ID "${channel.id}".`);
        }
        return message;
    }

    /**
     * Get a guild member.
     * @param userId The ID of the member to get.
     * @param guild The guild the member is a part of.
     * @returns The guild member or null if not found.
     * @throws An error if the member if not found.
     * If you don't want an error as a result, I recommend appending this call with .catch(() => null);
     */
    static async getGuildMember(userId: string, guild: Discord.Guild): Promise<Discord.GuildMember> {
        try {
            return await guild.members.fetch(userId);
        } catch (e) {
            // Improved error
            throw new Error(`Guild member not found.`);
        }
    }

    /**
     * Obtains a configurable message from a key string.
     * @param key The key for the message, relates to an entry in text-keys.json
     * @param args Arguments for the keyed message. Keyed messages can have indexes such as {0} to indicate which argument to insert.
     * @returns The associated message or a default error message.
     */
    static getKeyedMessage(key: string, ...args: string[]): string {
        let message = TextKeys[key].slice();
        if (!message) {
            return `Unable to find message for key "${key}". Contact a developer to have this fixed.`;
        }

        const matcher = /{([0-9]+)}/g;
        const matches = message.matchAll(matcher);

        for (const match of matches) {
            const index = parseInt(match[1]);
            let arg: string;
            if (isNaN(index)) {
                arg = '{NaN Argument Index!}';
            } else {
                arg = args[index] || '{Required Argument Missing!}';
            }

            message = message.replace(match[0], arg);
        }

        return message;
    }
}

export interface IConfig {
    report_channel_id: string,
    log_channel_id: string,
    thumbnail_icon_url: string,
    voice_category_id: string,
    onboarding_forum_id: string,
    permissions: {
        "all": string[],
        [permissionKey: string]: string[]
    },
    onboarding: {
        roles: {
            [key: string]: string
        },
        tags: {
            pending: string,
            approved: string,
            rejected: string,
            flagged: string,
            closed: string
        }
    },
    ranks: {
        [iron: string]: {
            required: string[],
            add: string[],
            remove: string[]
        }
    }
}

interface ITextKeys {
    [key: string]: string
}

const configPath = `${__dirname}/../storage/`;
for (let baseFileName of ['config', 'text-keys']) {
    const fileName = Utilities.getFileName(baseFileName);
    if (!fs.existsSync(`${configPath}/${fileName}.json`)) {
        fs.writeFileSync(`${configPath}/${fileName}.json`,
            // example files are the same dev or otherwise
            fs.readFileSync(`${configPath}/${baseFileName}-example.json`, {encoding: 'utf-8'}),
                {encoding: 'utf-8'});
    }
}

export const Config: IConfig = JSON.parse(fs.readFileSync(`${configPath}/${Utilities.getFileName('config')}.json`, {encoding: 'utf-8'}));
const TextKeys: ITextKeys = JSON.parse(fs.readFileSync(`${configPath}/${Utilities.getFileName('text-keys')}.json`, {encoding: 'utf-8'}));

/**
 * Component Interface - Represents a component's (button or string select menu) response method.
 * Not every component is required to have an IComponent to handle it. This is because we don't
 * always want to respond to every string select menu change.
 *
 * execute: The method that executes when the user clicks the button or changes the selection in
 *      the string select menu.
 */
export interface IComponent {
    execute: (interaction: Discord.ButtonInteraction | Discord.StringSelectMenuInteraction | Discord.ModalSubmitInteraction) => Promise<void>;
}

/**
 * All components are internally registered here.
 */
export const componentRegistry = new Discord.Collection<string, IComponent>();

/**
 * Command Interface - Represents a command's data and response method.
 *
 * data: A Discord.SlashCommandBuilder object that has been used to build the command's data.
 * execute: The method that executes when the command is called. Provides the interaction that
 * triggerd the command as an argument.
 * autocomplete: An optional method that executes to provide autocomplete options to the user.
 * components: An object with keys being custom IDs and values being IComponents. The customId key MUST
 *      match the button/select menu's custom ID.
 */
export interface ICommand {
    data: Discord.SlashCommandOptionsOnlyBuilder;
    execute: (interaction: Discord.ChatInputCommandInteraction) => Promise<void>;
    autocomplete?: (interaction: Discord.AutocompleteInteraction) => Promise<void>;
    components?: {[customId: string]: IComponent}
}

/**
 * All commands are internally registered here.
 */
export const commandRegistry = new Discord.Collection<string, ICommand>();

/**
 * Event Interface - Represents an event listener's data and response method.
 *
 * name: The name of the event from Discord.Events excluding VoiceServerUpdate and Raw.
 * once: true or excluded value, register as a one-time event (true) or repeat event (excluded).
 * execute: The method that executes when the event is triggered. Can take 0 or more arguments of any types.
 * Note: it is STRONGLY ENCOURAGED to explictly type all paramaters when defining execute as they cant be here.
 */
export interface IEvent {
    name: Exclude<Discord.Events, Discord.Events.Raw | Discord.Events.VoiceServerUpdate>;
    once?: true;
    execute: (...args: any) => Promise<void>;
}

/* event example:
let e: IEvent = {
    name: Discord.Events.ExampleEventThatDosentExist,
    once: true,
    execute(one: number, two: string) {}
}*/
