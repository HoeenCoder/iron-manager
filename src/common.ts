/**
 * Contains commonly used identifiers.
 */

import * as Discord from "discord.js";
import fs = require('fs');
import { client } from "./main";

export interface IConfig {
    report_channel_id: string,
    log_channel_id: string,
    thumbnail_icon_url: string,
    permissions: {
        "all": string[],
        [permissionKey: string]: string[]
    },
    ranks: {
        [iron: string]: {
            required: string[],
            add: string[],
            remove: string[]
        }
    }
}

const configPath = `${__dirname}/../storage/`;
if (!fs.existsSync(`${configPath}/${getFileName('config')}.json`)) {
    fs.writeFileSync(`${configPath}/${getFileName('config')}.json`,
        // config-example is the same dev or otherwise
        fs.readFileSync(`${configPath}/config-example.json`, {encoding: 'utf-8'}),
    {encoding: 'utf-8'});
}

export let Config: IConfig;
export function reloadConfig() {
    Config = JSON.parse(fs.readFileSync(`${configPath}/${getFileName('config')}.json`, {encoding: 'utf-8'}));
}
reloadConfig();

/**
 * Determine if a member can perform the requested action.
 * @param permissionKey The specific category of action being taken.
 * Each key is associated with an array of roles that can perform those tasks in config.json.
 * @param member The member taking the action.
 * @returns a boolean indicating if the action is permitted.
 */
export function roleBasedPermissionCheck(permissionKey: string, member: Discord.GuildMember): boolean {
    if (!(permissionKey in Config.permissions)) {
        if (!Config.permissions['all'] || !Config.permissions['all'].length) {
            console.log(`Permissions not configred! Please configure permissions in config.json!`);
            return false; // Perms not configured
        }
        permissionKey = 'all'; // default to global permission
    }

    const eligibleRoles = Config.permissions[permissionKey];
    const roles = member.roles.cache;

    for (const role of eligibleRoles) {
        if (roles.has(role)) {
            return true;
        }
    }

    return false;
}

/**
 * Command Interface - Represents a command's data and response method.
 * data: A Discord.SlashCommandBuilder object that has been used to build the command's data.
 * execute: The method that executes when the command is called. Provides the interaction that
 * triggerd the command as an argument.
 */
export interface ICommand {
    data: Discord.SlashCommandOptionsOnlyBuilder;
    execute: (interaction: Discord.ChatInputCommandInteraction) => void;
}

/**
 * All commands are internally registered here.
 */
export const commands = new Discord.Collection<string, ICommand>();

/**
 * Event Interface - Represents an event listener's data and response method.
 * name: The name of the event from Discord.Events excluding VoiceServerUpdate and Raw.
 * once: true or excluded value, register as a one-time event (true) or repeat event (excluded).
 * execute: The method that executes when the event is triggered. Can take 0 or more arguments of any types.
 * Note: it is STRONGLY ENCOURAGED to explictly type all paramaters when defining execute as they cant be here.
 */
export interface IEvent {
    name: Exclude<Discord.Events, Discord.Events.Raw | Discord.Events.VoiceServerUpdate>;
    once?: true;
    execute: (...args: any) => void;
}

/* event example:
let e: IEvent = {
    name: Discord.Events.ExampleEventThatDosentExist,
    once: true,
    execute(one: number, two: string) {}
}*/

/**
 * Get the bot's guild. The bot is programmed for a single guild currently.
 */
export async function getGuild(): Promise<Discord.Guild | null> {
    let guild = await client.guilds.fetch(process.env.GUILD_ID as string);
    if (!guild || !guild.available) return null;
    return guild;
}

/**
 * Get the updated file name (excluding extention and filepath) based on if dev mode is enabled
 */
export function getFileName(fileName: string): string {
    if (process.env.DEV_MODE) {
        return fileName + '-dev';
    }
    return fileName;
}

