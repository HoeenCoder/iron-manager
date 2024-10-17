import * as Discord from "discord.js";
import { ICommand, roleBasedPermissionCheck, Config, getGuild } from "../common";
import * as Logger from '../logger';
import { createUsername, tryPromotion } from "../iron-manager";

// rejectorId -> [rejecteeId, applicationMessageId]
const rejectionTable: {[rejectorId: string]: string[]} = {};

const commands: {[key: string]: ICommand} = {
    'post-onboarding-message': {
        data: new Discord.SlashCommandBuilder()
            .setName('post-onboarding-message')
            .setDescription('Display the message and button to open the onboarding popup. Must be High Command.'),
        async execute(interaction) {
            if (!roleBasedPermissionCheck('all', interaction.member as Discord.GuildMember)) {
                interaction.reply({content: `:x: Access Denied. Requires High Command permissions.`, ephemeral: true});
                return;
            }

            const guild = await getGuild();
            if (!guild) {
                throw new Error(`Guild not found!`);
            }

            const onboardingChannel = await guild.channels.fetch(Config.onboarding_channel_id);
            if (!onboardingChannel) {
                interaction.reply({content: `:x: Could not find onboarding report channel, please make sure its configured!`, ephemeral: true});
                return;
            }

            const button = new Discord.ActionRowBuilder<Discord.ButtonBuilder>()
                .addComponents(
                    new Discord.ButtonBuilder()
                        .setCustomId('start-onboarding-button')
                        .setLabel('Begin Onboarding')
                        .setStyle(Discord.ButtonStyle.Primary))

            await interaction.reply({
                content: `To join the 1st Colonial Regiment, please fill out the onboarding form by clicking this button:`,
                components: [button]
            });
        },
        components: {
            'start-onboarding-button': {
                async execute(interaction) {
                    if (!interaction.isButton()) {
                        throw new Error(`Onboarding: expected button, got ${interaction.isModalSubmit() ?
                            'Modal Submission' : interaction.componentType}.`);
                    }

                    const modal = new Discord.ModalBuilder()
                        .setCustomId('onboarding-modal')
                        .setTitle('1st Colonial Regiment Onboarding Form')
                        .addComponents(
                            new Discord.ActionRowBuilder<Discord.ModalActionRowComponentBuilder>().addComponents(
                                new Discord.TextInputBuilder()
                                    .setCustomId('onboarding-platform')
                                    .setLabel('Do you play on Steam or Playstation?')
                                    .setStyle(Discord.TextInputStyle.Short)
                                    .setMaxLength(11)
                                    .setRequired(true)),
                            new Discord.ActionRowBuilder<Discord.ModalActionRowComponentBuilder>().addComponents(
                                new Discord.TextInputBuilder()
                                    .setCustomId('onboarding-in-game-name')
                                    .setLabel('What is your in-game name?')
                                    .setStyle(Discord.TextInputStyle.Short)
                                    .setMaxLength(26)
                                    .setRequired(true)),
                            new Discord.ActionRowBuilder<Discord.ModalActionRowComponentBuilder>().addComponents(
                                new Discord.TextInputBuilder()
                                    .setCustomId('onboarding-microphone')
                                    .setLabel('Do you have a microphone?')
                                    .setPlaceholder('Yes or No')
                                    .setStyle(Discord.TextInputStyle.Short)
                                    .setMaxLength(3)
                                    .setRequired(true)),
                            new Discord.ActionRowBuilder<Discord.ModalActionRowComponentBuilder>().addComponents(
                                new Discord.TextInputBuilder()
                                    .setCustomId('onboarding-continent')
                                    .setLabel('What continent are you from?')
                                    .setPlaceholder('North America, Europe, Asia, etc...')
                                    .setStyle(Discord.TextInputStyle.Short)
                                    .setMaxLength(15)
                                    .setRequired(true)),
                            new Discord.ActionRowBuilder<Discord.ModalActionRowComponentBuilder>().addComponents(
                                new Discord.TextInputBuilder()
                                    .setCustomId('onboarding-age-check')
                                    .setLabel('Are you 16 years old or older?')
                                    .setPlaceholder('Yes or No. You must be 16+ to join.')
                                    .setStyle(Discord.TextInputStyle.Short)
                                    .setMaxLength(3)
                                    .setRequired(true)));

                    await interaction.showModal(modal);
                }
            },
            'onboarding-modal': {
                async execute(interaction) {
                    if (!interaction.isModalSubmit()) {
                        throw new Error(`Onboarding Submission: expected modal submission, got ${interaction.componentType}`);
                    }

                    const guild = await getGuild();
                    if (!guild) {
                        throw new Error(`Guild not found!`);
                    }

                    const onboardingChannel = await guild.channels.fetch(Config.onboarding_channel_id);
                    if (!onboardingChannel || !onboardingChannel.isSendable()) {
                        Logger.logToChannel(`Onboarding submission received but no sendable onboarding channel is configured! Please configure the onboarding channel!`);
                        throw new Error(`Onboarding channel not found!`);
                    }

                    // Validate user is an applicant
                    if (!interaction.member || !(interaction.member instanceof Discord.GuildMember)) {
                        // Should never happen...
                        throw new Error(`No reference to applicant who submitted onboarding form.`);
                    }

                    const applicant = interaction.member;
                    if (!applicant.roles.cache.hasAll(...Config.ranks[0].required)) {
                        await interaction.reply({
                            content: `:x: Only applicants can fill out an application form.`,
                            ephemeral: true
                        });
                        return;
                    }

                    // 1. Process inputs
                    const platform = interaction.fields.getTextInputValue('onboarding-platform');
                    const name = interaction.fields.getTextInputValue('onboarding-in-game-name');
                    const hasMic = interaction.fields.getTextInputValue('onboarding-microphone');
                    const continent = interaction.fields.getTextInputValue('onboarding-continent');
                    const ageCheck = interaction.fields.getTextInputValue('onboarding-age-check');

                    const embed = new Discord.EmbedBuilder()
                        .setColor(0x3b4d33)
                        .setTitle(`Regiment Join Request`)
                        .setAuthor({name: applicant.displayName, iconURL: applicant.displayAvatarURL()})
                        .setDescription(`Please review this new player's request to join the regiment.`)
                        .addFields(
                            {name: 'Account', value: `<@${applicant.id}>`},
                            {name: 'Platform', value: platform},
                            {name: 'In-Game Name', value: name},
                            {name: 'Has Microphone?', value: hasMic},
                            {name: 'Continent', value: continent},
                            {name: 'Stated they are 16+?', value: ageCheck},
                            {name: 'Application Status', value: 'Not Processed Yet'}
                        ).setTimestamp()
                        .setFooter({text: `Review the information and click Approve, or Reject.`});

                    if (Config.thumbnail_icon_url) embed.setThumbnail(Config.thumbnail_icon_url);

                    const buttonRow = new Discord.ActionRowBuilder<Discord.ButtonBuilder>()
                        .addComponents(
                            new Discord.ButtonBuilder()
                                .setCustomId('onboarding-applicant-approve')
                                .setLabel('Approve')
                                .setStyle(Discord.ButtonStyle.Success),
                            new Discord.ButtonBuilder()
                                .setCustomId('onboarding-applicant-reject')
                                .setLabel('Reject')
                                .setStyle(Discord.ButtonStyle.Danger),
                            new Discord.ButtonBuilder()
                                .setCustomId('onboarding-applicant-delete')
                                .setLabel('Delete Application')
                                .setStyle(Discord.ButtonStyle.Secondary));

                    await onboardingChannel.send({embeds: [embed], components: [buttonRow]});

                    await interaction.reply({content: `:white_check_mark: Your application was received and is under review!`, ephemeral: true});
                }
            },
            'onboarding-applicant-approve': {
                async execute(interaction) {
                    interaction.deferUpdate();

                    // 0. Permission checks
                    if (!interaction.isButton()) {
                        throw new Error(`Onboarding: expected button, got ${interaction.isModalSubmit() ?
                            'Modal Submission' : interaction.componentType}.`);
                    }

                    if (!roleBasedPermissionCheck('onboard', interaction.member as Discord.GuildMember)) {
                        interaction.reply({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                        return;
                    }

                    // 1. Validation
                    const guild = await getGuild();
                    if (!guild) {
                        throw new Error(`Guild not found!`);
                    }

                    const userMention = interaction.message.embeds[0].fields.find(f => f.name === 'Account')?.value || '';
                    const userId = (userMention.match(/<@([0-9]+)>/) || [])[1];
                    let applicant: Discord.GuildMember;

                    try {
                        applicant = await guild.members.fetch(userId);
                    } catch (e) {
                        await interaction.reply({
                            content: `Could not find applicant to approve, did they leave the server?\n\n` +
                                `You can delete this application with the "Delete Application" button.`,
                            ephemeral: true
                        });
                        return;
                    }

                    // Ensure applicant wasn't already approved/rejected.
                    if (!applicant.roles.cache.hasAny(...Config.ranks['0'].required)) {
                        await interaction.reply({
                            content: `Applicant does not have the role(s) new recruits have, maybe they were already approved or rejected?\n\n` +
                                `You can delete this application with the "Delete Application" button.`,
                            ephemeral: true,
                        });
                        return;
                    }

                    const ingameName = interaction.message.embeds[0].fields.find(f => f.name === 'In-Game Name')?.value || '';
                    if (!ingameName) {
                        throw new Error(`When onboarding, could not find applicant's in-game name!`);
                    }

                    const dataSets: {category: string, userInput: string, matchers: {[key: string]: RegExp}}[] = [
                        {
                            category: 'Platform',
                            userInput: interaction.message.embeds[0].fields.find(f => f.name === 'Platform')?.value || '',
                            matchers: {
                                'playstation': /(?:ps(?:4|5)?(?: pro)?|playstation)/i,
                                'steam': /(?:pc|steam(?: ?deck)?)/i
                            }
                        },
                        {
                            category: 'Continent',
                            userInput: interaction.message.embeds[0].fields.find(f => f.name === 'Continent')?.value || '',
                            matchers: {
                                'northAmerica': /(?:north ?america|na)/i,
                                'southAmerica': /(?:south ?america|sa)/i,
                                'europe': /(?:europe|eu)/i,
                                'oceania': /(?:oceania|oc|australia|aus)/i,
                                'asia': /(?:asia|as)/i,
                                //'africa': /(?:africa|af)/i
                                //'antartica': /(?:antartica|an)/i
                            }
                        }
                    ];

                    const problemEmbed = new Discord.EmbedBuilder()
                        .setColor(0x6c1313)
                        .setTitle(`Onboarding Problems`)
                        .setDescription(`Please manually assign roles for these categories to this user.`)
                        .addFields(
                            {name: `Account`, value: userMention}
                        ).setTimestamp()
                        .setFooter({text: `When fixed, click the button below this message to dismiss this message.`});

                    if (Config.thumbnail_icon_url) problemEmbed.setThumbnail(Config.thumbnail_icon_url);

                    // Role validation
                    const newRoles: Discord.Role[] = [];

                    for (let dataSet of dataSets) {
                        const userInput = dataSet.userInput;
                        const roleSet = dataSet.matchers;
                        let roleId: string | undefined = '';
                        for (let key in roleSet) {
                            if (userInput.match(roleSet[key])) {
                                roleId = key;
                                break;
                            }
                        }

                        if (!roleId || !applicant.manageable) {
                            problemEmbed.addFields({name: dataSet.category, value: userInput});
                        } else {
                            if (!Config.onboardingRoles[roleId]) {
                                throw new Error(`Onboarding role for ${roleId} not configured!`);
                            }
                            const role = await guild.roles.fetch(Config.onboardingRoles[roleId]);
                            if (!role || !role.editable) {
                                throw new Error(`Onboarding role for ${roleId} not found or the bot cannot assign it!`);
                            }
                            newRoles.push(role);
                        }
                    }

                    // 2. Assign roles, update name
                    const username = createUsername(0, ingameName);
                    if (applicant.manageable) {
                        await applicant.setNickname(username);
                    } else {
                        problemEmbed.addFields({name: 'Set Nickname To', value: username});
                    }

                    await applicant.roles.add(newRoles);

                    if (await tryPromotion(applicant, '0')) {
                        problemEmbed.addFields({name: 'Update Standard Roles',
                            value: `Add: ${Config.ranks[0].add.map(r => `<@&${r}>`)}, Remove: ${Config.ranks[0].remove.map(r => `<@&${r}>`)}`});
                    }

                    const appEmbed = interaction.message.embeds[0];
                    const field = appEmbed.fields.find(f => f.name === 'Application Status');
                    if (field) {
                        field.value = `Approved by <@${interaction.user.id}>`;
                    }

                    // Update embed, post new message if needed
                    interaction.editReply({
                        embeds: [appEmbed],
                        components: []
                    });

                    if (problemEmbed.data.fields && problemEmbed.data.fields.length > 1) {
                        const buttonRow = new Discord.ActionRowBuilder<Discord.ButtonBuilder>()
                            .addComponents(
                                new Discord.ButtonBuilder()
                                    .setCustomId('onboarding-problems-addressed')
                                    .setLabel('Problems Fixed, Dismiss Message')
                                    .setStyle(Discord.ButtonStyle.Primary)
                            )

                        interaction.followUp({
                            embeds: [problemEmbed],
                            components: [buttonRow]
                        });
                    }
                },
            },
            'onboarding-applicant-reject': {
                async execute(interaction) {
                    if (!interaction.isButton()) {
                        throw new Error(`Onboarding: expected button, got ${interaction.isModalSubmit() ?
                            'Modal Submission' : interaction.componentType}.`);
                    }

                    if (!roleBasedPermissionCheck('onboard', interaction.member as Discord.GuildMember)) {
                        interaction.reply({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                        return;
                    }

                    const guild = await getGuild();
                    if (!guild) {
                        throw new Error(`Guild not found!`);
                    }

                    const userMention = interaction.message.embeds[0].fields.find(f => f.name === 'Account')?.value || '';
                    const userId = (userMention.match(/<@([0-9]+)>/) || [])[1];
                    let applicant: Discord.GuildMember;

                    try {
                        applicant = await guild.members.fetch(userId);
                    } catch (e) {
                        await interaction.reply({
                            content: `Could not find applicant to reject, did they leave the server?`,
                            ephemeral: true
                        });
                        return;
                    }

                    // Ensure applicant wasn't already approved/rejected.
                    if (!applicant.roles.cache.hasAny(...Config.ranks['0'].required)) {
                        await interaction.reply({
                            content: `Applicant does not have the role(s) new recruits have, maybe they were already approved or rejected?\n\n` +
                                `You can delete this application with the "Delete Application" button.`,
                            ephemeral: true,
                        });
                        return;
                    }

                    // get reason from modal
                    const modal = new Discord.ModalBuilder()
                        .setCustomId('onboarding-rejection-modal')
                        .setTitle('Reject Applicant')
                        .addComponents(
                            new Discord.ActionRowBuilder<Discord.ModalActionRowComponentBuilder>().addComponents(
                                new Discord.TextInputBuilder()
                                    .setCustomId('onboarding-rejection-reason')
                                    .setLabel('Reason (shared with applicant)')
                                    .setStyle(Discord.TextInputStyle.Paragraph)
                                    .setMaxLength(400)
                                    .setRequired(true))
                        );

                    rejectionTable[interaction.user.id] = [applicant.id, interaction.message.id];

                    await interaction.showModal(modal);
                },
            },
            'onboarding-rejection-modal': {
                async execute(interaction) {
                    if (!interaction.isModalSubmit()) {
                        throw new Error(`Onboarding Rejection Submission: expected modal submission, got ${interaction.componentType}`);
                    }

                    if (!roleBasedPermissionCheck('onboard', interaction.member as Discord.GuildMember)) {
                        interaction.reply({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                        return;
                    }

                    interaction.deferReply();

                    const guild = await getGuild();
                    if (!guild) {
                        throw new Error(`Guild not found!`);
                    }

                    // DM reason, link to nexus and kick
                    let applicant: Discord.GuildMember;
                    const rejectionRecord = rejectionTable[interaction.user.id];

                    try {
                        applicant = await guild.members.fetch(rejectionRecord[0]);
                    } catch (e) {
                        await interaction.followUp({
                            content: `Could not find applicant to reject, did they leave the server?`
                        });
                        return;
                    }
                    const reason = interaction.fields.getTextInputValue('onboarding-rejection-reason') || 'No reason provided';

                    await applicant.send({
                        content: `Your application to the 1st Colonial Regiment was rejected for the following reasons:\n\n` +
                            `> ${reason}\n\n` +
                            `If your looking for others to play with, consider checking out the liberty nexus instead: https://discord.gg/EHdedDkzyu.\n\n` +
                            `*I am a bot and i do not respond to messages.*`
                    });

                    if (interaction.channel) {
                        const applicationMessage = await interaction.channel.messages.fetch(rejectionRecord[1]);

                        const appEmbed = applicationMessage.embeds[0];
                        const field = appEmbed.fields.find(f => f.name === 'Application Status');
                        if (field) {
                            field.value = `Rejected by <@${interaction.user.id}>`;
                        }

                        appEmbed.fields.push({
                            name: `Rejection Reason`,
                            value: reason.slice(0, 1024)
                        });

                        // Update embed, post new message if needed
                        applicationMessage.edit({
                            embeds: [appEmbed],
                            components: []
                        });
                    } else {
                        await interaction.followUp(`Unable to edit application for <@${applicant.id}> (${applicant.displayName}), message not found.`);
                    }

                    if (applicant.kickable) {
                        if (process.env.DEV_MODE) {
                            await interaction.followUp(`Reject applicant <@${applicant.id}> would be kicked, but development mode is enabled which disables this feature.`);
                        } else {
                            await applicant.kick(`Application rejected by ${interaction.user.displayName}, reason: ${reason}`);
                        }
                    } else {
                        await interaction.followUp(`Attempted to kick rejected applicant <@${applicant.id}>, but could not. Please manually remove them from the server.`);
                    }
                },
            },
            'onboarding-applicant-delete': {
                async execute(interaction) {
                    if (!interaction.isButton()) {
                        throw new Error(`Onboarding: expected button, got ${interaction.isModalSubmit() ?
                            'Modal Submission' : interaction.componentType}.`);
                    }

                    if (!roleBasedPermissionCheck('onboard', interaction.member as Discord.GuildMember)) {
                        interaction.reply({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                        return;
                    }

                    // Delete the message
                    interaction.message.delete();
                    interaction.reply({content: `:white_check_mark: Application Deleted.`, ephemeral: true});
                }
            },
            'onboarding-problems-addressed': {
                async execute(interaction) {
                    if (!interaction.isButton()) {
                        throw new Error(`Onboarding: expected button, got ${interaction.isModalSubmit() ?
                            'Modal Submission' : interaction.componentType}.`);
                    }

                    if (!roleBasedPermissionCheck('onboard', interaction.member as Discord.GuildMember)) {
                        interaction.reply({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                        return;
                    }

                    // Delete the message
                    interaction.message.delete();
                    interaction.reply({content: `:white_check_mark: Problem Report Deleted.`, ephemeral: true});
                },
            }
        }
    }
};

module.exports = commands;