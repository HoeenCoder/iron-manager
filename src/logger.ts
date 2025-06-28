import fs = require('fs');
import Luxon = require('luxon');
import { Config, Utilities } from './common';
import * as Discord from 'discord.js';
import crypto = require('crypto');

const LOCK_TIMEOUT = 1000 * 60; // 1 minute

function generateLogTimestamp() {
    return Luxon.DateTime.utc().toLocaleString(Luxon.DateTime.DATETIME_MED_WITH_SECONDS).replace(' ', ' ');
}

/**
 * Prevents race conditions when accessing data
 */
abstract class Lock {
    private locked: string = '';
    private waiting: ((value: string) => void)[] = [];
    private timeout: NodeJS.Timeout | null = null;

    /**
     * Locks the relevant data making all other requests wait for this one to finish.
     * This method will return the transaction key when the data becomes avaliable.
     * You MUST unlock the data with a call to unlock before the transaction times out.
     * @returns Transaction key required for most actions on the data.
     */
    async lock(): Promise<string> {
        if (this.locked) {
            return new Promise<string>((resolver) => {
                this.waiting.push(resolver);
            });
        } else {
            this.locked = crypto.randomUUID();
            this.timeout = setTimeout(async () => {
                await this.unlock(this.locked);
                throw new Error(`Transaction exceeded maximum time limit of ${LOCK_TIMEOUT / 1000} seconds.`);
            }, LOCK_TIMEOUT);
            return new Promise<string>((resolver) => {
                resolver(this.locked);
            });
        }
    }

    /**
     * Releases a transactional lock, requires the key created when locking the data.
     * The key will be invalidated by this action, if you need to read or modify the data
     * again, obtain a new lock.
     * @param key Transaction key required for most actions on the data.
     */
    async unlock(key: string) {
        this.tryKey(key);
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }

        if (this.waiting.length) {
            const resolver = this.waiting.shift() as ((value: string) => void);
            this.locked = crypto.randomUUID();
            this.timeout = setTimeout(async () => {
                await this.unlock(this.locked);
                throw new Error(`Transaction exceeded maximum time limit of ${LOCK_TIMEOUT / 1000} seconds.`);
            }, LOCK_TIMEOUT);
            resolver(this.locked);
        } else {
            this.locked = '';
        }
    }

    /**
     * Validate the provided transaction key. Throws an error if invalid, silently returns if valid.
     * @param key Transaction key required for most actions on the data.
     */
    protected tryKey(key: string): void {
        if (!this.locked || this.locked !== key) {
            throw new Error(`Lock violation: ${this.locked ? 'bad key' : 'not locked'}.`);
        }
    }
}

/**
 * Manages IRON logging
 */
export namespace IronLogger {
    export type IronAchivementType = 'deployment' | 'commendation';

    export interface MemberWeeklyIronLog {
        numDeployments: number;
        deployment?: true;
        commendation?: true;
    }

    interface IronJSON {
        weekTimestamp: number;
        members: {
            [member: string]: MemberWeeklyIronLog
        }
    }

    class IronLock extends Lock {
        private fileLoc: string;
        private iron: IronJSON;

        constructor() {
            super();
            this.fileLoc = `${__dirname}/../storage/${Utilities.getFileName('iron')}.json`;

            if (!fs.existsSync(this.fileLoc)) {
                this.iron = {
                    weekTimestamp: this.calcCurWeekTimestamp(),
                    members: {}
                };

                fs.writeFileSync(this.fileLoc, JSON.stringify(this.iron), {encoding: 'utf-8'});
            } else {
                this.iron = JSON.parse(fs.readFileSync(this.fileLoc, {encoding: 'utf-8'}));
            }
        }

        /**
         * Overriden version of Lock's lock method to insert data validation when a transaction starts.
         * Obtains the key first (super.lock()) THEN validates and returns it.
         * @returns Transaction key required for most actions on the data.
         */
        async lock(): Promise<string> {
            const key = await super.lock();
            this.validateData(key);
            return key;
        }

        /**
         * Internal method that handles the deployment week changing.
         * @param key The transaction key to ensure the method caller holds the lock for this data.
         */
        private validateData(key: string): void {
            this.tryKey(key);

            let weekStart = this.calcCurWeekTimestamp();
            if (this.iron.weekTimestamp === weekStart) {
                // Week has not changed since last check
                return;
            }

            // Update timestamp, wipe values
            this.iron.weekTimestamp = weekStart;
            this.iron.members = {};

            this.writeJSON();
            console.log(`[NOTICE] New week detected, iron reset.`);
        }

        /**
         * Internal method to calculate the current week's weekly timestamp.
         * @returns The unix timestamp representing the start of the current deployment week.
         */
        private calcCurWeekTimestamp(): number {
            let now = Luxon.DateTime.utc().startOf('day');
            if (now.weekday === 1) {
                now = now.minus({ days: 1});
            }

            return now.set({weekday: 2}).toMillis();
        }

        /**
        * Gets IRON data for a specific member.
        * Data indicates if the member has earned iron via deployment and/or commendation this week.
        * @param key The transaction key to ensure the method caller holds the lock for this data.
        * @param memberID Discord snowflake user ID
        * @returns The member's iron data
        */
        readIron(key: string, memberID: string): MemberWeeklyIronLog {
            this.tryKey(key);

            return this.iron.members[memberID] || {numDeployments: 0};
        }

        /**
         * Writes IRON data for a set of members as a batch.
         * Data indicates if the member has earned iron via deployment and/or commendation this week.
         * @param key The transaction key to ensure the method caller holds the lock for this data.
         * @param members Array of Discord snowflake user IDs
         * @param type The type of deployment to mark this user as having taken part in.
         */
        writeIron(key: string, members: string[], type: IronAchivementType): void {
            this.tryKey(key);

            for (let m of members) {
                if (!this.iron.members[m]) this.iron.members[m] = {numDeployments: 0};
                this.iron.members[m][type] = true;
            }

            this.writeJSON();
        }

        /**
         * Increment the number of deployments that each member
         * in the provided set has participated in this week.
         * @param key The transaction key to ensure the method caller holds the lock for this data.
         * @param members Array of Discord snowflake user IDs
         */
        incrementDeploymentTracker(key: string, members: string[]): void {
            this.tryKey(key);

            for (let m of members) {
                if (!this.iron.members[m]) this.iron.members[m] = {numDeployments: 0};
                this.iron.members[m].numDeployments++;
            }

            this.writeJSON();
        }

        /**
         * Obtain the current week's timestamp. Data is validated when this is requested.
         * @param key The transaction key to ensure the method caller holds the lock for this data.
         * @returns The current week's timestamp.
         */
        async getCurrentWeekTimestamp(key: string): Promise<number> {
            // tryKey called in validateData
            this.validateData(key);

            return this.iron.weekTimestamp;
        }

        /**
         * Resets IRON data as if a new week started. Only avaliable in dev mode.
         * @param key The transaction key to ensure the method caller holds the lock for this data.
         */
        resetIron(key: string) {
            if (!process.env.DEV_MODE) {
                throw new Error(`Attempted to reset IRON outside of dev mode.`);
            }
            this.tryKey(key);

            this.iron = {
                weekTimestamp: this.calcCurWeekTimestamp(),
                members: {}
            };
            this.writeJSON();
        }

        /**
         * Internal method to perform the actual JSON write.
         */
        private writeJSON(): void {
            // Key not required because this is used internally only
            fs.writeFileSync(this.fileLoc, JSON.stringify(this.iron), {encoding: 'utf-8'});
        }
    }

    export const dataManager = new IronLock();
}

/**
 * Manages deployment voice activity logging
 */
export namespace DeploymentActivityLogger {
    interface DeploymentActivityJSON {
        active: boolean,
        operationName: string,
        started: string,
        members: {[memberId: string]: MemberDeploymentActivityRecord}
    }

    export interface MemberDeploymentActivityRecord {
        joined: number | null
        totalTime: number
    }

    export interface DeploymentQualificationRecord {
        qualified: string[],
        particpated: string[]
    }

    export const MINIMUM_TIME_TO_QUALIFY = 1000 * 60 * 60; // 1 hour

    class DeploymentActivityLock extends Lock {
        private jsonFileLoc: string;
        private logDirLoc: string;
        private activityRecords: DeploymentActivityJSON;
        private recoveryRequired: boolean = false;

        constructor() {
            super();
            this.jsonFileLoc = `${__dirname}/../storage/${Utilities.getFileName('deployment-voice')}.json`;
            this.logDirLoc = `${__dirname}/../storage/deployment-logs`;

            if (!fs.existsSync(this.jsonFileLoc)) {
                this.activityRecords = {
                    active: false,
                    operationName: "",
                    started: '',
                    members: {}
                };

                fs.writeFileSync(this.jsonFileLoc, JSON.stringify(this.activityRecords), {encoding: 'utf-8'});
            } else {
                this.activityRecords = JSON.parse(fs.readFileSync(this.jsonFileLoc, {encoding: 'utf-8'}));
            }

            if (!fs.existsSync(this.logDirLoc)) {
                fs.mkdirSync(this.logDirLoc);
            }

            if (this.activityRecords.active) {
                this.recoveryRequired = true;
            }
        }

        async runRecovery(): Promise<void> {
            if (!this.recoveryRequired) return;
            this.recoveryRequired = false;
            const key = await this.lock();
            const inactiveIds = Object.keys(this.activityRecords.members);

            // 1. Ensure all members activly in VC are marked as active
            const guild = await Utilities.getGuild().catch(() => null);
            if (!guild) return;
            const voiceCategory = await Utilities.getGuildChannel(Config.voice_category_id, guild).catch(() => null);
            if (!voiceCategory) return;

            if (voiceCategory.type !== Discord.ChannelType.GuildCategory) {
                throw new Error(`When performing deployment activity recovery, voice channel category is not a category. ID: ${Config.voice_category_id}`);
            }

            this.appendSpecialLog('Unexpected reboot detected, initiating recovery mode.');

            for (const [channelId, channel] of voiceCategory.children.cache) {
                if (channel.type !== Discord.ChannelType.GuildVoice || channel.members.size < 1) continue;

                for (const [memberId, member] of channel.members) {
                    const idx = inactiveIds.indexOf(member.id);
                    if (idx >= 0) {
                        inactiveIds.splice(idx, 1);
                    }

                    if (!this.activityRecords.members[member.id]) {
                        this.activityRecords.members[member.id] = {joined: null, totalTime: 0};
                    }

                    if (!this.activityRecords.members[member.id].joined) {
                        this.activityRecords.members[member.id].joined = Date.now();
                        this.appendLogFile(member.id, true, this.activityRecords.members[member.id].totalTime);
                    }
                }
            }

            // 2. Ensure all records not in VC are marked as inactive
            for (const memberId of inactiveIds) {
                if (this.activityRecords.members[memberId].joined) {
                    this.activityRecords.members[memberId].totalTime +=
                        Date.now() - this.activityRecords.members[memberId].joined;
                    this.activityRecords.members[memberId].joined = null;
                    this.appendLogFile(memberId, false, this.activityRecords.members[memberId].totalTime);
                }
            }

            // 3. Write data, release lock
            this.writeJSON();
            this.appendSpecialLog('Recovery completed.');
            await this.unlock(key);
        }

        reportJoin(key: string, memberId: string) {
            this.tryKey(key);
            if (!this.activityRecords.members[memberId]) {
                this.activityRecords.members[memberId] = {
                    joined: null,
                    totalTime: 0
                };
            }

            if (this.activityRecords.members[memberId].joined) {
                throw new Error(`Join reported when user is already marked as active`);
            }

            this.activityRecords.members[memberId].joined = Date.now();
            this.appendLogFile(memberId, true, this.activityRecords.members[memberId].totalTime);
            this.writeJSON();
        }

        reportLeave(key: string, memberId: string) {
            this.tryKey(key);
            if (!this.activityRecords.members[memberId]) {
                this.activityRecords.members[memberId] = {
                    joined: null,
                    totalTime: 0
                };
            }

            if (!this.activityRecords.members[memberId].joined) {
                throw new Error(`Leave reported when user isn't marked as active`);
            }

            this.activityRecords.members[memberId].totalTime += Date.now() - this.activityRecords.members[memberId].joined;
            this.activityRecords.members[memberId].joined = null;
            this.writeJSON();
            this.appendLogFile(memberId, false, this.activityRecords.members[memberId].totalTime);
        }

        isDeploymentActive(key: string): boolean {
            this.tryKey(key);
            return this.activityRecords.active;
        }

        async startDeployment(key: string, operationName: string) {
            this.tryKey(key);
            if (this.activityRecords.active) {
                throw new Error(`Attempting to start a deployment while one is already running.`);
            }
            this.resetJSON();

            // Detect members who are already deployed
            const guild = await Utilities.getGuild().catch(() => null);
            if (!guild) return;
            const voiceCategory = await Utilities.getGuildChannel(Config.voice_category_id, guild).catch(() => null);
            if (!voiceCategory) return;

            if (voiceCategory.type !== Discord.ChannelType.GuildCategory) {
                throw new Error(`When performing starting deployment, voice channel category is not a category. ID: ${Config.voice_category_id}`);
            }

            this.activityRecords.started = this.prepareLogFile();
            this.appendSpecialLog(`Deployment "${operationName}" Started.`);

            for (const [channelId, channel] of voiceCategory.children.cache) {
                if (channel.type !== Discord.ChannelType.GuildVoice || channel.members.size < 1) continue;

                for (const [memberId, member] of channel.members) {
                    if (!this.activityRecords.members[member.id]) {
                        this.activityRecords.members[member.id] = {joined: null, totalTime: 0};
                    }

                    if (!this.activityRecords.members[member.id].joined) {
                        this.activityRecords.members[member.id].joined = Date.now();
                    }

                    this.appendLogFile(member.id, true, 0);
                }
            }

            this.activityRecords.operationName = operationName;
            this.activityRecords.active = true;
            this.writeJSON();
        }

        endDeployment(key: string) {
            this.tryKey(key);
            if (!this.activityRecords.active) {
                throw new Error(`Attempting to end a deployment while one isn't running.`);
            }

            this.activityRecords.active = false;
            const operationName = this.activityRecords.operationName;
            const endTime = Date.now();
            for (const memberId in this.activityRecords.members) {
                if (this.activityRecords.members[memberId].joined) {
                    this.activityRecords.members[memberId].totalTime +=
                        endTime - this.activityRecords.members[memberId].joined;
                    this.activityRecords.members[memberId].joined = null;
                    this.appendLogFile(memberId, false, this.activityRecords.members[memberId].totalTime);
                }
            }
            this.writeJSON();
            this.appendSpecialLog(`Deployment "${operationName}" Ended.`);
        }

        getOperationName(key: string): string {
            this.tryKey(key);
            return this.activityRecords.operationName;
        }

        getQualifiedMembers(key: string): DeploymentQualificationRecord {
            this.tryKey(key);

            const results: DeploymentQualificationRecord = {
                qualified: [],
                particpated: []
            };

            for (let memberId in this.activityRecords.members) {
                const record = this.activityRecords.members[memberId];
                let time = record.totalTime;
                if (record.joined) {
                    time += Date.now() - record.joined;
                }

                if (time >= MINIMUM_TIME_TO_QUALIFY) {
                    results.qualified.push(memberId);
                } else {
                    results.particpated.push(memberId);
                }
            }

            return results;
        }

        getMemberData(key: string, memberId: string): MemberDeploymentActivityRecord | null {
            this.tryKey(key);
            return this.activityRecords.members[memberId] || null;
        }

        // Keyless public methods, only reads info and there wont be an issue if a race conflict occurs.
        getLogFileNames(): string[] {
            return fs.readdirSync(this.logDirLoc, {encoding: 'utf-8'})
                .filter(f => f.endsWith('.log'));
        }

        getFullLogFilePath(name: string): string {
            return `${this.logDirLoc}/${name}`;
        }

        private resetJSON() {
            this.activityRecords = {
                active: false,
                operationName: "",
                started: '',
                members: {}
            };

            this.writeJSON();
        }

        private writeJSON() {
            fs.writeFileSync(this.jsonFileLoc, JSON.stringify(this.activityRecords), {encoding: 'utf-8'});
        }

        private prepareLogFile(): string {
            const timestamp = Luxon.DateTime.utc();
            const fileName = `${timestamp.toISODate()}T${timestamp.toISOTime().split('.')[0].replace(/:/g, '-')}`;
            if (!fs.existsSync(`${this.logDirLoc}/${fileName}.log`)) {
                fs.writeFileSync(`${this.logDirLoc}/${fileName}.log`,
                    'ALL TIMES SHOWN ARE IN UTC.\nTIMESTAMP JOIN/LEAVE USER_ID ACTIVE TIME.\n', {encoding: 'utf-8'});
            }

            return fileName;
        }

        private appendLogFile(memberId: string, join: boolean, totalTime: number) {
            const type = join ? 'JOIN' : 'LEAVE';
            const duration = Luxon.Duration.fromMillis(totalTime).rescale().toHuman({unitDisplay: "short"});

            fs.appendFileSync(`${this.logDirLoc}/${this.activityRecords.started}.log`,
                `${generateLogTimestamp()}: ${type} ${memberId}. Active Time: ${duration || '0 ms'}.\n`,
                {encoding: 'utf-8'});
        }

        private appendSpecialLog(msg: string) {
            fs.appendFileSync(`${this.logDirLoc}/${this.activityRecords.started}.log`,
                `${generateLogTimestamp()}: ${msg}\n`, {encoding: 'utf-8'});
        }
    }

    export const dataManager = new DeploymentActivityLock();
}

/**
 * For logging onboarding applications
 */
export namespace OnboardingLogger {
    const logDirLoc = `${__dirname}/../storage/onboarding-logs`;
    export function logCreation(applicant: Discord.User | Discord.GuildMember, platform: string, ign: string,
        hasMic: string, continent: string, is16Plus: string) {
        writeLogFile(applicant.id, `APPLICATION CREATED. IGN: ${ign}, Platform: ${platform}, ` +
            `Has Mic: ${hasMic}, Continent: ${continent}, Confirmed 16+: ${is16Plus}.`);
    }

    export function logApproval(applicant: Discord.User | Discord.GuildMember, approver: Discord.GuildMember) {
        writeLogFile(applicant.id, `APPLICATION APPROVED by ${approver.displayName} (${approver.id})`);
    }

    export function logRejection(applicant: Discord.User | Discord.GuildMember, rejector: Discord.GuildMember, reason: string) {
        writeLogFile(applicant.id, `APPLICATION REJECTED by ${rejector.displayName} (${rejector.id}). Reason: ${reason.replace('\n', ' ')}`);
    }

    export function logFlag(applicantId: string, flagger: Discord.GuildMember, reason: string) {
        writeLogFile(applicantId, `APPLICATION FLAGGED by ${flagger.displayName} (${flagger.id}). Reason: ${reason.replace('\n', ' ')}`);
    }

    export function logFlagCleared(applicantId: string, flagger: Discord.GuildMember) {
        writeLogFile(applicantId, `APPLICATION FLAG_CLEARED by ${flagger.displayName} (${flagger.id}).`);
    }

    export function logClose(applicantId: string, closer: Discord.GuildMember) {
        writeLogFile(applicantId, `APPLICATION CLOSED by ${closer.displayName} (${closer.id}).`);
    }

    function writeLogFile(memberId: string, message: string) {
        if (!fs.existsSync(logDirLoc)) {
            fs.mkdirSync(logDirLoc);
        }

        fs.appendFileSync(`${logDirLoc}/${memberId}.log`, `${generateLogTimestamp()}: ${message}\n`, {encoding: 'utf-8'});
    }

    export function getValidFileNames() {
        return fs.readdirSync(logDirLoc, {encoding: 'utf-8'})
                .filter(f => f.endsWith('.log'));
    }

    export function getFullLogFilePath(name: string): string {
        return `${logDirLoc}/${name}`;
    }
}

export namespace PersistentMessages {
    interface PersistentMessageJSON {
        [messageCategory: string]: {
            [guildId: string]: {
                channelId: string,
                messageId: string
            }
        }
    }

    class PersistentMessageManager extends Lock {
        private jsonFileLoc: string;
        private messageData: PersistentMessageJSON;

        constructor() {
            super();

            this.jsonFileLoc = `${__dirname}/../storage/${Utilities.getFileName('persisted-messages')}.json`;
            if (!fs.existsSync(this.jsonFileLoc)) {
                this.messageData = {};
                this.writeJSON();
            } else {
                this.messageData = JSON.parse(fs.readFileSync(this.jsonFileLoc, {encoding: 'utf-8'}));
            }
        }

        async getMessage(key: string, messageCategory: string, guild: Discord.Guild): Promise<Discord.Message | null> {
            this.tryKey(key);

            if (!this.messageData[messageCategory] || !this.messageData[messageCategory][guild.id]) {
                return null; // Category or guild entry doesn't exist
            }

            try {
                const channel = await Utilities.getGuildChannel(this.messageData[messageCategory][guild.id].channelId, guild);
                return await Utilities.getGuildMessage(this.messageData[messageCategory][guild.id].messageId, channel);
            } catch (e) {
                // Channel or message no longer exists or can't be accessed
                return null;
            }
        }

        async persistMessage(key: string, messageCategory: string, message: Discord.Message) {
            this.tryKey(key);

            if (!message.guild) {
                throw new Error(`Guildless messages do not support persistance.`);
            }

            if (!this.messageData[messageCategory]) {
                this.messageData[messageCategory] = {};
            }

            this.messageData[messageCategory][message.guild.id] = {
                channelId: message.channel.id,
                messageId: message.id
            };

            this.writeJSON();
        }

        async unPersistMessage(key: string, messageCategory: string, guildId: string) {
            this.tryKey(key);

            if (!guildId || !this.messageData[messageCategory]) {
                // category not found or guild not provided.
                return;
            }

            if (this.messageData[messageCategory][guildId]) {
                // Delete the data if it exists.
                delete this.messageData[messageCategory][guildId];
                if (Object.keys(this.messageData[messageCategory]).length < 1) {
                    // Delete the category if empty now.
                    delete this.messageData[messageCategory];
                }

                this.writeJSON();
            }
        }

        private writeJSON() {
            fs.writeFileSync(this.jsonFileLoc, JSON.stringify(this.messageData), {encoding: 'utf-8'});
        }
    }

    export const dataManager = new PersistentMessageManager();
}

/**
 * General purpose logging functionality
 */
export namespace Logger {
    export function logError(e: any) {
        let errorText = e;
        if (e instanceof Error) {
            errorText = `${(e as Error).message}\n${(e as Error).stack}`;
        }

        console.error(e);
        fs.appendFileSync(`${__dirname}/../storage/${Utilities.getFileName('errors')}.log`, `${generateLogTimestamp()}: ${errorText}\n\n`, {encoding: 'utf-8'});
    }

    export async function logToChannel(msg: string) {
        fs.appendFileSync(`${__dirname}/../storage/${Utilities.getFileName('notices')}.log`, `${generateLogTimestamp()}: ${msg}\n\n`, {encoding: 'utf-8'});

        const guild = await Utilities.getGuild().catch(() => null);
        if (!guild) return;

        const channel = await Utilities.getGuildChannel(Config.log_channel_id, guild).catch(() => null);
        if (!channel) return;

        if (!channel.isSendable()) {
            throw new Error(`Log channel is not sendable!`);
        }

        channel.send(msg);
    }

    export async function logEmbedToChannel(embed: Discord.EmbedBuilder) {
        fs.appendFileSync(`${__dirname}/../storage/${Utilities.getFileName('notices')}.log`, `${generateLogTimestamp()}: ${JSON.stringify(embed.data)}\n\n`, {encoding: 'utf-8'});
        console.log(`[NOTICE] Embed titled "${embed.data.title}" logged to ${Utilities.getFileName('notices')}.log`);

        const guild = await Utilities.getGuild().catch(() => null);
        if (!guild) return;
        const channel = await Utilities.getGuildChannel(Config.log_channel_id, guild).catch(() => null);
        if (!channel) return;

        if (!channel.isSendable()) {
            throw new Error(`Log channel is not sendable!`);
        }

        channel.send({embeds: [embed]});
    }
}
