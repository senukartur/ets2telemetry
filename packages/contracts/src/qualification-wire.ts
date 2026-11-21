// Generated VTC-164 component types pinned at be706fc329ed360e26e9a98c690fca8d30384101.
export interface components {
    schemas: {
        /** @description Exact canonical aggregate distance, matching the owning progress Decimal output. Unlike individual DECIMAL(38,18) values, SUM may exceed20 integer digits. Output only. */
        AggregateDecimal: string;
        Assessment: {
            assessedSource: components["schemas"]["SourceIdentity"] | null;
            assignmentId: string | null;
            /** @enum {string} */
            availability: "retained" | "historical_unavailable";
            /**
             * Format: date-time
             * @description Canonical UTC serialization with milliseconds: YYYY-MM-DDTHH:mm:ss.SSSZ (24 characters).
             */
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
            trailerComparison: components["schemas"]["TrailerComparison"] | null;
            trailerDisplay: components["schemas"]["TrailerDisplay"][];
        };
        Assignment: {
            /** Format: uuid */
            id: string;
            level: components["schemas"]["LevelIdentity"];
            limits: components["schemas"]["Limits"];
            /**
             * Format: date-time
             * @description Canonical UTC serialization with milliseconds: YYYY-MM-DDTHH:mm:ss.SSSZ (24 characters).
             */
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
                code: "TOKEN_INVALID" | "INGESTION_FORBIDDEN" | "CAPABILITY_REQUIRED" | "INVALID_PAYLOAD" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" | "NOT_FOUND" | "RATE_LIMITED" | "TEMPORARILY_UNAVAILABLE" | "RESULT_BATCH_TOO_LARGE";
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
                /**
                 * @description Absent means legacy variant/common-model comparison. Type selects the semantic type dictionary; a saved basis is never replaced by current classification.
                 * @enum {string}
                 */
                basis?: "variant" | "type";
                /** @enum {string} */
                mode: "any" | "selected";
                typeIds: string[];
            };
        };
        Preview: {
            applicability: {
                contextRevision: number;
                /**
                 * Format: date-time
                 * @description Canonical UTC serialization with milliseconds: YYYY-MM-DDTHH:mm:ss.SSSZ (24 characters).
                 */
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
            /**
             * Format: date-time
             * @description Canonical UTC serialization with milliseconds: YYYY-MM-DDTHH:mm:ss.SSSZ (24 characters).
             */
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
            /** @description Bounded distinct coupling/configuration observations, current and previous. One item per configuration, not per physical trailer slot. code is exact SDK trailers.items[0].bodyType for that configuration, matching frozen ingestion. Null holes and incomplete history remain explicit. */
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
            creditedDistanceM: components["schemas"]["AggregateDecimal"];
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
            /**
             * Format: date-time
             * @description Canonical UTC serialization with milliseconds: YYYY-MM-DDTHH:mm:ss.SSSZ (24 characters).
             */
            asOf: string;
            assignment: components["schemas"]["Assignment"] | null;
            /** @constant */
            contract: "1.0";
            game: components["schemas"]["Game"];
            /**
             * Format: date-time
             * @description Canonical UTC serialization with milliseconds: YYYY-MM-DDTHH:mm:ss.SSSZ (24 characters).
             */
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
            /** @description Durable monotonic domain owner counter. Presentation-only changes leave it equal. */
            resultRevision: string;
            source: components["schemas"]["SourceIdentity"];
            sourceOutcome: ("open" | "delivered" | "cancelled" | "none") | null;
            /** @enum {string} */
            state: "not_received" | "processing" | "review" | "decided";
            unchanged: boolean;
            /** @description Opaque validator including all current presentation content except asOf. Equal domain revisions may have different versions; never sort this value. */
            version: components["schemas"]["ResultVersion"];
        };
        ResultBatch: {
            /**
             * Format: date-time
             * @description Canonical UTC serialization with milliseconds: YYYY-MM-DDTHH:mm:ss.SSSZ (24 characters).
             */
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
        /** @description Complete deterministically ordered saved QualificationSnapshot.trailerGroups. No current lookup or truncation; omitted mapping keys retain literal-ID fallback. Null on Assessment means old mapping unavailable. */
        TrailerComparison: {
            /** @enum {string} */
            basis: "variant" | "type";
            entries: {
                comparisonIdentity: components["schemas"]["TrailerComparisonIdentity"];
                /** Format: uuid */
                id: string;
            }[];
        };
        /** @description Exact saved ASCII comparison token. undefined means unclassified at assessment; common contains the original model bytes in hexadecimal. */
        TrailerComparisonIdentity: string;
        TrailerDisplay: {
            /**
             * Format: date-time
             * @description Canonical UTC serialization with milliseconds: YYYY-MM-DDTHH:mm:ss.SSSZ (24 characters).
             */
            asOf: string;
            /** @constant */
            basis: "current_catalog";
            /** @description Current variant classification only, never the retained comparison mapping. Semantic identities are not_applicable; missing metadata is unavailable. */
            classification: {
                /** @constant */
                state: "classified";
                /** Format: uuid */
                typeId: string;
            } | {
                /** @enum {string} */
                state: "unclassified" | "not_applicable" | "unavailable";
            };
            code: string | null;
            /** @description Current legacy common-model presentation only; always null for a semantic type identity. */
            groupCode: string | null;
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            identityKind: "variant" | "type" | "unavailable";
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
