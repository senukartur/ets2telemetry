// Generated VTC-164 component types pinned at 9a53e09755f7731da865aa3bdc4bac8a7cafe724.
export interface components {
    schemas: {
        Assessment: {
            assessedSource: components["schemas"]["SourceIdentity"] | null;
            assignmentId: string | null;
            /** @enum {string} */
            availability: "retained" | "historical_unavailable";
            /** Format: date-time */
            decidedAt: string;
            /** Format: uuid */
            decisionId: string;
            decisionSequence: number;
            eventExempt: boolean;
            /** Format: uuid */
            factId: string;
            level: components["schemas"]["LevelIdentity"] | null;
            limits: components["schemas"]["Limits"] | null;
            materialIdentity: string;
            outcome: ("pass" | "fail" | "unknown") | null;
            reasons: ("qualification_cargo_mass" | "qualification_distance" | "qualification_trailer" | "qualification_adr" | "qualification_hard_mode" | "qualification_unknown" | "qualification_level_unknown" | "qualification_attribution_time_unknown" | "event_attendance_exemption")[];
            rules: components["schemas"]["Rule"][];
            sourceEventId: string | null;
            sourceMessageId: string | null;
            sourceRevision: number | null;
            trailerDisplay: components["schemas"]["TrailerDisplay"][];
        };
        Assignment: {
            /** Format: uuid */
            id: string;
            level: components["schemas"]["LevelIdentity"];
            limits: components["schemas"]["Limits"];
            /** Format: date-time */
            startedAt: string;
            trailerDisplay: components["schemas"]["TrailerDisplay"][];
        };
        Capabilities: {
            /** @constant */
            capability: "companion.own.v1";
            /** @constant */
            contract: "1.0";
            games: components["schemas"]["Game"][];
            /** @constant */
            maxBatch: 25;
            /** @constant */
            maxBodyBytes: 16384;
            /** @constant */
            pollMinimumSeconds: 5;
            previewEnabled: boolean;
            /** @constant */
            previewTtlSeconds: 5;
            qualificationEnabled: boolean;
            resultsEnabled: boolean;
            securityScope: components["schemas"]["SecurityScope"];
        };
        CodeFact: {
            /** @enum {string} */
            availability: "known" | "unknown";
            code: string | null;
        };
        Conditions: {
            requiredDistanceM: string | null;
            requiredTrips: number | null;
        };
        Decimal: string;
        DecimalFact: {
            /** @enum {string} */
            availability: "known" | "unknown";
            value: string | null;
        };
        Error: {
            error: {
                /** @enum {string} */
                code: "TOKEN_INVALID" | "INGESTION_FORBIDDEN" | "CAPABILITY_REQUIRED" | "INVALID_PAYLOAD" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" | "NOT_FOUND" | "RATE_LIMITED" | "TEMPORARILY_UNAVAILABLE";
                retryable: boolean;
            };
            requestId: string;
        };
        /** @enum {string} */
        Game: "ets2" | "ats";
        LevelIdentity: {
            editVersion: number;
            /** Format: uuid */
            id: string;
            name: string;
        };
        Limits: {
            adr: {
                classes: ("1" | "2" | "3" | "4" | "6" | "8")[];
                /** @enum {string} */
                mode: "any" | "forbidden" | "selected";
            };
            distanceMaxM: string | null;
            distanceMinM: string | null;
            hardModeRequired: boolean;
            massMaxKg: string | null;
            massMinKg: string | null;
            trailers: {
                /** @enum {string} */
                mode: "any" | "selected";
                typeIds: string[];
            };
        };
        Preview: {
            applicability: {
                contextRevision: number;
                /** Format: date-time */
                expiresAt: string;
                maximumDistanceM: string | null;
                minimumDistanceM: string | null;
                qualificationRevision: string;
                requiresQualificationRefresh: boolean;
            };
            assignment: components["schemas"]["Assignment"] | null;
            /** @enum {string} */
            basis: "historical_assignment" | "current_projection" | "unavailable";
            contextRevision: number;
            /** @constant */
            contract: "1.0";
            /** Format: date-time */
            evaluatedAt: string;
            eventExempt: boolean;
            evidenceRevision: number;
            /** @enum {string} */
            outcome: "pass" | "fail" | "unknown";
            /** @constant */
            provisional: true;
            reasons: ("below_minimum_growing" | "hard_mode_not_final" | "unsupported_distance" | "fact_unavailable" | "limit_mismatch" | "assignment_missing" | "module_unavailable" | "event_unresolved")[];
            /** Format: uuid */
            requestId: string;
            rules: components["schemas"]["Rule"][];
            securityScope: components["schemas"]["SecurityScope"];
            trailerDisplay: components["schemas"]["TrailerDisplay"][];
        };
        PreviewInput: {
            actualDistance: {
                /** @enum {string} */
                availability: "known" | "unknown";
                final: boolean;
                metres: string | null;
                /** @enum {string} */
                support: "whole-trip" | "partial" | "unknown";
            };
            cargo: components["schemas"]["CodeFact"];
            cargoMassKg: components["schemas"]["DecimalFact"];
            contextRevision: number;
            eventId: string | null;
            evidenceRevision: number;
            game: components["schemas"]["Game"];
            hardMode: {
                final: boolean;
                /** @enum {string} */
                result: "qualified" | "not-qualified" | "unknown";
            };
            /** Format: uuid */
            requestId: string;
            start: {
                /** @enum {string} */
                basis: "actual" | "unknown";
                /** Format: date-time */
                utc: string;
            } | null;
            trailers: {
                complete: boolean;
                items: {
                    code: string | null;
                    /** @enum {string} */
                    provenance: "attached" | "previous" | "unknown";
                }[];
            };
        };
        Progress: {
            conditions: components["schemas"]["Conditions"];
            conditionsMet: boolean;
            creditedDistanceM: string;
            creditedTrips: number;
            nextLevel: {
                /** Format: uuid */
                id: string;
                name: string;
            } | null;
            remainingDistanceM: string | null;
            remainingTrips: number | null;
            terminal: boolean;
        };
        Qualification: {
            /** Format: date-time */
            asOf: string;
            assignment: components["schemas"]["Assignment"] | null;
            /** @constant */
            contract: "1.0";
            game: components["schemas"]["Game"];
            /** Format: date-time */
            offlineUsableUntil: string;
            /** Format: uuid */
            ownerId: string;
            progress: components["schemas"]["Progress"] | null;
            progressRevision: string;
            refreshAfterSeconds: number;
            securityScope: components["schemas"]["SecurityScope"];
            /** @enum {string} */
            state: "assigned" | "assignment_missing" | "unavailable";
        };
        Result: {
            assessment: components["schemas"]["Assessment"] | null;
            /** @enum {string} */
            assessmentBasis: "none" | "current" | "predecessor";
            assessmentPending: boolean;
            canonicalTripId: string | null;
            /** @enum {string} */
            companyDecision: "unassessed" | "pending_review" | "accepted" | "rejected";
            correctionPending: boolean;
            credit: {
                actualDistanceM: string | null;
                assignmentId: string | null;
                credited: boolean;
                trips: number;
            } | null;
            latestSourceRevision: number | null;
            /** @enum {string} */
            receipt: "not_received" | "received";
            /** Format: uuid */
            requestedEventId: string;
            requestedRevision: number;
            requestedSourceMessageId: string | null;
            resultRevision: string;
            source: components["schemas"]["SourceIdentity"];
            sourceOutcome: ("open" | "delivered" | "cancelled" | "none") | null;
            /** @enum {string} */
            state: "not_received" | "processing" | "review" | "decided";
            unchanged: boolean;
            version: components["schemas"]["ResultVersion"];
        };
        ResultBatch: {
            /** Format: date-time */
            asOf: string;
            /** @constant */
            contract: "1.0";
            items: components["schemas"]["Result"][];
            refreshAfterSeconds: number;
            /** Format: uuid */
            requestId: string;
            securityScope: components["schemas"]["SecurityScope"];
        };
        ResultBatchInput: {
            items: components["schemas"]["SourceRequest"][];
            /** Format: uuid */
            requestId: string;
        };
        ResultVersion: string;
        Rule: {
            maxKg: string | null;
            minKg: string | null;
            observedKg: string | null;
            reasons: ("within_limits" | "unrestricted" | "limit_mismatch" | "fact_unavailable" | "below_minimum_growing" | "hard_mode_not_final" | "unsupported_distance" | "event_attendance_exemption")[];
            /** @enum {string} */
            result: "pass" | "fail" | "unknown";
            /** @constant */
            rule: "cargo_mass";
        } | {
            maxM: string | null;
            minM: string | null;
            observedM: string | null;
            reasons: ("within_limits" | "unrestricted" | "limit_mismatch" | "fact_unavailable" | "below_minimum_growing" | "hard_mode_not_final" | "unsupported_distance" | "event_attendance_exemption")[];
            /** @enum {string} */
            result: "pass" | "fail" | "unknown";
            /** @constant */
            rule: "distance";
        } | {
            allowedIds: string[];
            /** @enum {string} */
            mode: "any" | "selected";
            observedIds: string[];
            reasons: ("within_limits" | "unrestricted" | "limit_mismatch" | "fact_unavailable" | "below_minimum_growing" | "hard_mode_not_final" | "unsupported_distance" | "event_attendance_exemption")[];
            /** @enum {string} */
            result: "pass" | "fail" | "unknown";
            /** @constant */
            rule: "trailer_types";
        } | {
            allowedClasses: ("1" | "2" | "3" | "4" | "6" | "8")[];
            /** @enum {string} */
            mode: "any" | "forbidden" | "selected";
            observed: ("1" | "2" | "3" | "4" | "6" | "8" | "none") | null;
            reasons: ("within_limits" | "unrestricted" | "limit_mismatch" | "fact_unavailable" | "below_minimum_growing" | "hard_mode_not_final" | "unsupported_distance" | "event_attendance_exemption")[];
            /** @enum {string} */
            result: "pass" | "fail" | "unknown";
            /** @constant */
            rule: "adr";
        } | {
            observed: ("qualified" | "not-qualified" | "unknown") | null;
            reasons: ("within_limits" | "unrestricted" | "limit_mismatch" | "fact_unavailable" | "below_minimum_growing" | "hard_mode_not_final" | "unsupported_distance" | "event_attendance_exemption")[];
            required: boolean;
            /** @enum {string} */
            result: "pass" | "fail" | "unknown";
            /** @constant */
            rule: "hard_mode";
        };
        SecurityScope: string;
        SourceIdentity: {
            game: components["schemas"]["Game"];
            /** Format: uuid */
            pluginSessionId: string;
            /** @constant */
            provider: "ets2telemetry";
            /** Format: uuid */
            tripId: string;
        };
        SourceRequest: {
            /** Format: uuid */
            eventId: string;
            ifVersion?: components["schemas"]["ResultVersion"];
            revision: number;
            source: components["schemas"]["SourceIdentity"];
        };
        TrailerDisplay: {
            /** Format: date-time */
            asOf: string;
            /** @constant */
            basis: "current_catalog";
            code: string | null;
            groupCode: string | null;
            /** Format: uuid */
            id: string;
            nameEn: string | null;
            nameRu: string | null;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
