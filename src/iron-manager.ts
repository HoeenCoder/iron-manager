/**
 * Module for managing the issuing of iron to members
 */
import RomanNumerals = require('roman-numerals');
import * as Discord from 'discord.js';
import * as Logger from './logger';
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

export async function distributeIron(members: Discord.GuildMember[], type: Logger.IronAchivementType): Promise<IronDistributionResults | Error> {
    const verificationTimestamp = Logger.getCurrentWeekTimestamp();
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

        let data: Logger.MemberWeeklyIronLog;
        try {
            data = Logger.readIron(member.id, verificationTimestamp);
        } catch (e) {
            // Weekly tick likely occured mid-update, terminate early.
            if (!(e as Error).name || !(e as Error).message) {
                // ??!
                throw e;
            }
            return (e as Error);
        }

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

    try {
        Logger.writeIron(attemptToIssue.map(m => m.id), type, verificationTimestamp);
    } catch (e) {
        // Weekly tick likely occured mid-update, terminate early.
        if (!(e as Error).name || !(e as Error).message) {
            // ??!
            throw e;
        }
        return (e as Error);
    }

    // Update usernames, ranks
    recentlyUpdatedNames = [];
    for (let member of attemptToIssue) {
        const parsed = parseUsername(member.displayName);
        if (!parsed) {
            // should never happen
            throw new Error(`Invalid name when attempting to issue iron! Name: ${member.displayName}`);
        }
        parsed[0]++;

        const username = createUsername(...parsed);
        if (!member.manageable) {
            const newNumerals = parsed[0] <= 31 && parsed[0] > 0 ? RomanNumerals.toRoman(parsed[0]) : parsed[0] + '';
            results.namePermsError.push([member, newNumerals]);
            continue;
        }
        recentlyUpdatedNames.push(member.id);
        await member.setNickname(username);

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
    const matches = username.match(/^\[ ?((?:[IVXL]|[0-9])+) ?\] (.+)$/i);
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

function createUsername(iron: number, name: string): string {
    // 17, "Example Name" -> "[ XVII ] Example Name"
    if (iron < 0) {
        throw new Error(`IRON count when assembling username was negative. name: ${name}, iron: ${iron}`);
    }
    let numerals = (iron === 0 || iron > 30) ? iron + '' : RomanNumerals.toRoman(iron);

    // length check
    let length = 4 + numerals.length + name.length;
    if (length <= 32) {
        // Ok for [ IRON ] NAME
        return `[ ${numerals} ] ${name}`;
    } else if (length - 2 <= 32) {
        // Use [IRON] NAME
        return `[${numerals}] ${name}`;
    } else {
        // try using decimal instead of roman numerals
        length = 4 + ('' + iron).length + name.length;
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
 * @param iron Member's new iron count
 * @returns true if an error occurs, false if not.
 */
async function tryPromotion(member: Discord.GuildMember, iron: string): Promise<boolean> {
    if (!Object.keys(Config.ranks).includes(iron)) return false; // No promotion at this iron count
    const rank = Config.ranks[iron];

    if (!member.manageable) {
        return true;
    }
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
