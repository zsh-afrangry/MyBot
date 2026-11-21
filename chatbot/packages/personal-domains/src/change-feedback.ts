import {businessFeedback} from '../../feedback-core/index.js';
import type {ConfirmationScope} from '@kurumi/confirmation-core';
import {formatDateTime, formatTimestamp} from './time-display.js';
import {WeatherStore, type TripSummary} from './store.js';
import {weatherStateDirectory} from './paths.js';

export function locationSavedFeedback(proposalId: string, savedLocation: string, committedAtUtc: number) {
  return businessFeedback('current_location.set', 'succeeded', {proposalId, savedLocation, committedAtUtc});
}

export function tripSavedFeedback(proposalId: string, trip: TripSummary) {
  return businessFeedback('trip.create', 'succeeded', {
    proposalId, tripId: trip.id, destination: trip.destinationDisplayName ?? trip.destinationText,
  });
}

export function presentTrip(trip: TripSummary, timezone: string) {
  return {...trip, displayTimes: {
    timezone,
    timezoneSource: 'profile.currentLocation' as const,
    departureEarliest: formatDateTime(trip.departureEarliestUtc, timezone),
    departureLatest: formatDateTime(trip.departureLatestUtc, timezone),
    arrivalEarliest: formatDateTime(trip.arrivalEarliestUtc, timezone),
    arrivalLatest: formatDateTime(trip.arrivalLatestUtc, timezone),
  }};
}

export function readChangeFeedback(kind: 'location_set' | 'trip_create', proposalId: string, scope: ConfirmationScope | undefined) {
  const unavailable = (code: string) => ({ok: false, error: {code}});
  if (!scope) return unavailable('proposal_not_found');
  let store: WeatherStore | undefined;
  try {
    store = new WeatherStore({stateDirectory: weatherStateDirectory(), readOnly: true});
    const outcome = store.readChangeOutcome(kind, proposalId, scope);
    if (!outcome) return unavailable('proposal_not_found');
    const {proposal, current, asOfUtc} = outcome;
    const currentLocation = current.place.displayName;
    const action = kind === 'location_set' ? 'current_location.set' : 'trip.create';
    if (proposal.status !== 'committed') {
      const status = proposal.status === 'pending'
        ? asOfUtc >= proposal.expiresAtUtc ? 'expired' : 'pending_confirmation'
        : proposal.status;
      return {ok: true, currentLocation, feedback: businessFeedback(action, status, {
        proposalId, expiresAtDisplay: formatTimestamp(proposal.expiresAtUtc, current.place.timezone),
      })};
    }
    if (proposal.kind === 'location_set' && proposal.displayName && proposal.committedAtUtc !== null) {
      return {ok: true, currentLocation,
        matchesCurrentLocation: proposal.resultPlaceId === current.place.id,
        feedback: locationSavedFeedback(proposalId, proposal.displayName, proposal.committedAtUtc)};
    }
    if (proposal.kind === 'trip_create' && proposal.trip) {
      return {ok: true, currentLocation, trip: presentTrip(proposal.trip, current.place.timezone),
        feedback: tripSavedFeedback(proposalId, proposal.trip)};
    }
    return {ok: true, currentLocation, feedback: businessFeedback(action, 'unknown', {proposalId})};
  } catch {
    return unavailable('feedback_unavailable');
  } finally {
    store?.close();
  }
}
