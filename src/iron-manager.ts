/**
 * Module for managing the issuing of iron to members
 */
import RomanNumerals = require('roman-numerals');
import * as Discord from 'discord.js';
import { IronLogger, Logger } from './logger';
import { Config } from './common';

export interface IronDistributionResults {
    issued: Discord.GuildMember[],
    notIssued: Discord.GuildMember[],
    duplicates: Discord.GuildMember[],
    invalidName: Discord.GuildMember[],
    namePermsError: [Discord.GuildMember, string][],
    rankPermsError: Discord.GuildMember[]
}

export let recentlyUpdatedNames: string[] = [];

export async function distributeIron(members: Discord.GuildMember[], type: IronLogger.IronAchivementType): Promise<IronDistributionResults> {
    const key = await IronLogger.dataManager.lock();
    const completedIDs: string[] = [];
    const results: IronDistributionResults = {
        issued: [],
        notIssued: [],
        duplicates: [],
        invalidName: [],
        namePermsError: [],
        rankPermsError: []
    };
    const attemptToIssue: Discord.GuildMember[] = [];

    for (let member of members) {
        if (completedIDs.includes(member.id)) {
            results.duplicates.push(member);
            continue;
        }

        const data = IronLogger.dataManager.readIron(key, member.id);
        if (data[type]) {
            // Already got iron
            results.notIssued.push(member);
        } else {
            // Issue iron, specifically iron will be issued after JSON is updated
            // check if their name is OK first
            if (!parseUsername(member.displayName)) {
                // Name in bad format, cancel distribution, ask for human intervention
                results.invalidName.push(member);
            } else {
                attemptToIssue.push(member);
            }
        }

        completedIDs.push(member.id);
    }

    // Write data and end transaction
    IronLogger.dataManager.writeIron(key, attemptToIssue.map(m => m.id), type);
    await IronLogger.dataManager.unlock(key);

    // Update usernames, ranks
    recentlyUpdatedNames = [];
    for (let member of attemptToIssue) {
        const parsed = parseUsername(member.displayName);
        if (!parsed) {
            // should never happen, can't throw here safely.
            await Logger.logToChannel(`Invalid name when attempting to issue iron! Name: ${member.displayName}.\n\n` +
                `Please fix their username and manually increase their IRON count by 1 (via nickname editing).`
            );
            continue;
        }
        parsed[0]++;

        const username = createUsername(...parsed);
        if (!member.manageable) {
            const newNumerals = parsed[0] <= 500 && parsed[0] > 0 ? RomanNumerals.toRoman(parsed[0]) : parsed[0] + '';
            results.namePermsError.push([member, newNumerals]);
            continue;
        }
        recentlyUpdatedNames.push(member.id);
        await member.setNickname(username).catch((e) => {
            // Should never happen but OK, we can't crash here, handle it the best we can.
            Logger.logToChannel(`Error when attempting to issue iron! Target username: ${username}.\n\n` +
                `Please set their username to the one provided above (via nickname editing).`
            );
            Logger.logError(e);
        });

        // Try to promote, if an error occurs due to permissions...
        if (await tryPromotion(member, '' + parsed[0])) {
            results.rankPermsError.push(member);
            continue;
        }

        results.issued.push(member);
    }
    recentlyUpdatedNames = [];

    return results;
}

function parseUsername(username: string): [number, string] | null {
    // "[ XVII ] Example Name" -> [17, "Example Name"]
    const matches = username.match(/^\[ ?((?:[IVXLCDM]|[0-9])+) ?\] (.+)$/i);
    if (!matches) {
        // bad username format
        return null;
    }

    let numeral;
    try {
        numeral = RomanNumerals.toArabic(matches[1]);
    } catch (e) {
        // is this a normal number instead?
        numeral = parseInt(matches[1]);
        if (isNaN(numeral)) {
            // Bad numeral
            return null;
        }
    }

    return [numeral, matches[2]];
}

export function createUsername(iron: number, name: string): string {
    // 17, "Example Name" -> "[ XVII ] Example Name"
    if (iron < 0) {
        throw new Error(`IRON count when assembling username was negative. name: ${name}, iron: ${iron}`);
    }
    let numerals = (iron === 0 || iron > 500) ? iron + '' : RomanNumerals.toRoman(iron);

    // length check
    let length = 5 + numerals.length + name.length;
    if (length <= 32) {
        // Ok for [ IRON ] NAME
        return `[ ${numerals} ] ${name}`;
    } else if (length - 2 <= 32) {
        // Use [IRON] NAME
        return `[${numerals}] ${name}`;
    } else {
        // try using decimal instead of roman numerals
        length = 5 + ('' + iron).length + name.length;
        if (length <= 32) {
            // Use [ IRON ] NAME
            return `[ ${iron} ] ${name}`;
        } else {
            // Use [IRON] NAME, trim to 32 chars if over 32
            return `[${iron}] ${name}`.substring(0, 32);
        }
    }
}

/**
 * See if a member who just received iron should be promoted and if so promote them.
 * @param member Guild member to check a promotion for
 * @param ironCount Member's new iron count
 * @returns true if an error occurs, false if not.
 */
export async function tryPromotion(member: Discord.GuildMember, ironCount: string): Promise<boolean> {
    // 1. Check to see if theres a promotion to perform
    if (!Object.keys(Config.ranks).includes(ironCount)) return false; // No promotion at this iron count
    const rank = Config.ranks[ironCount];

    // 2. Validate the user has the required role(s)
    if (!member.roles.cache.hasAll(...rank.required)) {
        // Member lacks one or more required roles
        return false;
    }

    // 3. Check if the bot can manage this user
    if (!member.manageable) {
        return true;
    }

    // 4. Update roles
    const roleManager = member.guild.roles;
    const roles = rank.add.concat(rank.remove);

    for (const r of roles) {
        const role = await roleManager.fetch(r);
        if (!role || !role.editable) {
            return true;
        }
    }

    await member.roles.add(rank.add);
    await member.roles.remove(rank.remove);
    return false;
}
