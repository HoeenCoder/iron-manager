import { IEvent } from '../common';
import * as Discord from 'discord.js';
import { DeploymentActivityLogger } from '../logger';
import { Config } from '../common';

const events: {[key: string]: IEvent} = {
    deployment_voice_monitor: {
        name: Discord.Events.VoiceStateUpdate,
        async execute(oldState: Discord.VoiceState, newState: Discord.VoiceState) {
            if (!oldState.member || !newState.member) return; // No member
            if (oldState.channelId === newState.channelId) return; // No channel change
            if (!oldState.channel && !newState.channel) return; // Double null channel

            const oldActive = oldState.channel && oldState.channel.parent && oldState.channel.parent.id === Config.voice_category_id;
            const newActive = newState.channel && newState.channel.parent && newState.channel.parent.id === Config.voice_category_id;
            if (oldActive === newActive) return; // Swapped between two channels in the same category group, ignore

            const key = await DeploymentActivityLogger.transactionManager.lock();
            if (DeploymentActivityLogger.transactionManager.isDeploymentActive(key)) {
                if (!oldActive && newActive) {
                    // Join
                    DeploymentActivityLogger.transactionManager.reportJoin(key, newState.member.id);
                } else {
                    // Leave
                    DeploymentActivityLogger.transactionManager.reportLeave(key, oldState.member.id);
                }
            }
            await DeploymentActivityLogger.transactionManager.unlock(key);
        }
    }
};

module.exports = events;
