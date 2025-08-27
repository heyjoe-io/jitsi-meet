import { IReduxState } from '../app/types';

/**
 * Checks if the current user is waiting for host.
 *
 * @param {IReduxState} state - The Redux state.
 * @returns {boolean} True if waiting for host.
 */
export function isWaitingForHost(state: IReduxState): boolean {
    return Boolean((state as any)['features/waiting-for-host']?.waiting);
}

/**
 * Gets the number of participants waiting for host.
 *
 * @param {IReduxState} state - The Redux state.
 * @returns {number} The participant count.
 */
export function getWaitingRoomParticipantCount(state: IReduxState): number {
    return (state as any)['features/waiting-for-host']?.participantCount || 0;
}

/**
 * Checks if the current participant should wait for host based on JWT presence and participant count.
 *
 * @param {IReduxState} state - The Redux state.
 * @returns {boolean} True if participant should wait.
 */
export function shouldWaitForHost(state: IReduxState): boolean {
    // Skip waiting logic for Jibri
    if (isJibriParticipant(state)) {
        return false;
    }
    
    const { jwt } = state['features/base/jwt'];
    const participantsState = state['features/base/participants'];
    const localParticipant = participantsState.local;
    
    // If user has JWT token or is already a moderator, they should not wait
    if (jwt || localParticipant?.role === 'moderator') {
        return false;
    }
    
    // Check if there are any moderators already in the meeting
    // Include both local and remote moderators
    const localIsModerator = localParticipant?.role === 'moderator';
    const hasRemoteModeratorInMeeting = Array.from(participantsState.remote.values())
        .some((participant: any) => participant.role === 'moderator');
    
    // If no moderators in meeting, should wait
    return !localIsModerator && !hasRemoteModeratorInMeeting;
}

/**
 * Checks if the participant is Jibri (recording bot).
 *
 * @param {IReduxState} state - The Redux state.
 * @returns {boolean} True if participant is Jibri.
 */
export function isJibriParticipant(state: IReduxState): boolean {
    const localParticipant = state['features/base/participants'].local;
    
    // Jibri typically has a specific bot type or can be identified by specific properties
    // Check for Jibri specific properties
    if (localParticipant?.botType === 'jibri' || 
        localParticipant?.isJigasi === true ||
        localParticipant?.name?.toLowerCase().includes('jibri') ||
        localParticipant?.name?.toLowerCase().includes('recorder')) {
        return true;
    }
    
    // Check user agent for Jibri patterns
    const userAgent = navigator.userAgent;
    if (userAgent.includes('chrome-headless') || userAgent.includes('ChromeHeadless')) {
        return true;
    }
    
    return false;
}