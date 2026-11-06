-- Synthetic frozen schema 5 projection preparation, generated with base 3ad76411 migrations 1-5.
PRAGMA foreign_keys=OFF;
PRAGMA application_id=1163154226;
PRAGMA user_version=5;
CREATE TABLE database_info (id INTEGER PRIMARY KEY CHECK (id = 1), database_uuid TEXT NOT NULL CHECK (database_uuid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
    purpose TEXT NOT NULL CHECK (purpose IN ('history', 'synthetic', 'replay')), accepted_origin TEXT NOT NULL CHECK (accepted_origin IN ('game', 'synthetic', 'replay')),
    created_utc_ms INTEGER NOT NULL CHECK (created_utc_ms >= 0), created_app_version TEXT NOT NULL CHECK (length(created_app_version) BETWEEN 1 AND 64),
    CHECK ((purpose = 'history' AND accepted_origin = 'game') OR (purpose = 'synthetic' AND accepted_origin = 'synthetic') OR (purpose = 'replay' AND accepted_origin = 'replay'))) STRICT;
INSERT INTO "database_info" VALUES(1,'f0000000-0000-4000-8000-000000000002','synthetic','synthetic',1791676800000,'0.1.0');
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY CHECK (version >= 1), name TEXT NOT NULL, applied_utc_ms INTEGER NOT NULL CHECK (applied_utc_ms >= 0),
    app_version TEXT NOT NULL, backup_file_name TEXT, backup_sha256 TEXT CHECK (length(backup_sha256) = 64 AND backup_sha256 NOT GLOB '*[^0-9a-f]*'),
    CHECK ((backup_file_name IS NULL) = (backup_sha256 IS NULL))) STRICT;
INSERT INTO "schema_migrations" VALUES(1,'0001-initial',1791676800000,'0.1.0',NULL,NULL);
INSERT INTO "schema_migrations" VALUES(2,'0002-journal',1791676800000,'0.1.0',NULL,NULL);
INSERT INTO "schema_migrations" VALUES(3,'0003-hard-mode',1793588400000,'0.1.0-fixture',NULL,NULL);
INSERT INTO "schema_migrations" VALUES(4,'0004-logical-trips',1792148400000,'0.1.0-fixture','telemetry-f0000000-v3-20261016T110000000Z.sqlite','73953fb05bd55eb19c5d019b2577da06797268347f5cb4fa3b2951f790a3c483');
INSERT INTO "schema_migrations" VALUES(5,'0005-upload-projections',1793966400000,'0.1.0-fixture','telemetry-f0000000-v4-20261106T120000000Z.sqlite','b03f0ce2ed49cbcbb34b5fb183d7c072e20739ac2d382e8112a71cb93dd0d066');
CREATE TABLE plugin_sessions (id INTEGER PRIMARY KEY, plugin_session_uuid TEXT NOT NULL CHECK (plugin_session_uuid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]') UNIQUE, game TEXT NOT NULL CHECK (game IN ('ets2', 'ats')),
    origin TEXT NOT NULL CHECK (origin IN ('game', 'synthetic', 'replay')), process_instance_uuid TEXT NOT NULL CHECK (process_instance_uuid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
    process_id INTEGER NOT NULL CHECK (process_id BETWEEN 1 AND 4294967295), windows_session_id INTEGER NOT NULL CHECK (windows_session_id BETWEEN 0 AND 4294967295),
    protocol_major INTEGER NOT NULL CHECK (protocol_major = 1), protocol_minor INTEGER NOT NULL CHECK (protocol_minor BETWEEN 0 AND 65535),
    telemetry_api_major INTEGER NOT NULL CHECK (telemetry_api_major BETWEEN 0 AND 65535), telemetry_api_minor INTEGER NOT NULL CHECK (telemetry_api_minor BETWEEN 0 AND 65535), game_telemetry_major INTEGER NOT NULL CHECK (game_telemetry_major BETWEEN 0 AND 65535), game_telemetry_minor INTEGER NOT NULL CHECK (game_telemetry_minor BETWEEN 0 AND 65535),
    sdk_archive TEXT NOT NULL CHECK (length(sdk_archive) BETWEEN 1 AND 128), gameplay_events TEXT NOT NULL CHECK (gameplay_events IN ('registered', 'not-supported')),
    event_types_json TEXT NOT NULL CHECK (json_valid(event_types_json)),
    game_mode TEXT NOT NULL CHECK (game_mode IN ('single-player', 'truckersmp', 'unknown', 'convoy')), game_mode_method TEXT NOT NULL CHECK (game_mode_method IN ('module-scan', 'process-scan', 'none')),
    game_mode_confidence TEXT NOT NULL CHECK (game_mode_confidence IN ('strong', 'weak', 'none')), game_mode_module TEXT, game_mode_module_state TEXT NOT NULL CHECK (game_mode_module_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((game_mode_module_state = 'available') = (game_mode_module IS NOT NULL)),
    committed_through_event_seq TEXT NOT NULL CHECK (length(committed_through_event_seq) = 20 AND committed_through_event_seq NOT GLOB '*[^0-9]*' AND committed_through_event_seq <= '18446744073709551615'), first_seen_utc_ms INTEGER NOT NULL CHECK (first_seen_utc_ms >= 0),
    end_reason TEXT CHECK (end_reason IN ('plugin-shutdown', 'sequence-exhausted', 'source-retired')), end_next_event_seq TEXT CHECK (end_next_event_seq IS NULL OR (length(end_next_event_seq) = 20 AND end_next_event_seq NOT GLOB '*[^0-9]*' AND end_next_event_seq <= '18446744073709551615')),
    CHECK ((end_reason IS NULL) = (end_next_event_seq IS NULL))) STRICT;
INSERT INTO "plugin_sessions" VALUES(1,'10000000-0000-4000-8000-000000000001','ets2','synthetic','20000000-0000-4000-8000-000000000001',12345,1,1,0,1,1,1,19,'scs-sdk-1.15','registered','["job.configured","job.delivered"]','single-player','module-scan','weak',NULL,'not-observed','00000000000000000006',1791676800000,'plugin-shutdown','00000000000000000007');
INSERT INTO "plugin_sessions" VALUES(2,'10000000-0000-4000-8000-000000000002','ets2','synthetic','20000000-0000-4000-8000-000000000002',12346,1,1,0,1,1,1,19,'scs-sdk-1.15','registered','["job.configured","job.delivered"]','unknown','none','none',NULL,'not-observed','00000000000000000001',1791676810000,NULL,NULL);
CREATE TABLE clocks (id INTEGER PRIMARY KEY, plugin_session_ref INTEGER NOT NULL REFERENCES plugin_sessions (id),
    kind TEXT NOT NULL CHECK (kind IN ('source-monotonic', 'game')), clock_uuid TEXT NOT NULL CHECK (clock_uuid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'), UNIQUE (plugin_session_ref, kind, clock_uuid)) STRICT;
INSERT INTO "clocks" VALUES(1,1,'source-monotonic','30000000-0000-4000-8000-000000000001');
INSERT INTO "clocks" VALUES(2,1,'game','40000000-0000-4000-8000-000000000001');
INSERT INTO "clocks" VALUES(3,2,'source-monotonic','30000000-0000-4000-8000-000000000001');
INSERT INTO "clocks" VALUES(4,2,'game','40000000-0000-4000-8000-000000000001');
CREATE TABLE events (id INTEGER PRIMARY KEY, plugin_session_id INTEGER NOT NULL REFERENCES plugin_sessions (id), event_seq TEXT NOT NULL CHECK ((length(event_seq) = 20 AND event_seq NOT GLOB '*[^0-9]*' AND event_seq <= '18446744073709551615') AND event_seq > '00000000000000000000' AND event_seq <= '18446744073709551614'),
    type TEXT NOT NULL CHECK (type IN ('job.configured', 'job.cleared', 'truck.configured', 'truck.cleared', 'trailer.configured', 'trailer.cleared', 'simulation.paused', 'simulation.started', 'timers.restart', 'gameTime.regression', 'job.delivered', 'job.cancelled', 'player.fined', 'player.tollgate.paid', 'player.use.ferry', 'player.use.train', 'source.gameMode')),
    occurred_monotonic_ns TEXT CHECK ((length(occurred_monotonic_ns) = 20 AND occurred_monotonic_ns NOT GLOB '*[^0-9]*' AND occurred_monotonic_ns <= '18446744073709551615')), occurred_monotonic_ns_state TEXT NOT NULL CHECK (occurred_monotonic_ns_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((occurred_monotonic_ns_state = 'available') = (occurred_monotonic_ns IS NOT NULL)), source_clock_ref INTEGER NOT NULL REFERENCES clocks (id),
    occurred_game_minutes INTEGER CHECK (occurred_game_minutes BETWEEN 0 AND 4294967295), occurred_game_minutes_state TEXT NOT NULL CHECK (occurred_game_minutes_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((occurred_game_minutes_state = 'available') = (occurred_game_minutes IS NOT NULL)), occurred_game_clock_ref INTEGER NOT NULL REFERENCES clocks (id),
    occurred_utc_ms TEXT CHECK ((length(occurred_utc_ms) = 20 AND occurred_utc_ms NOT GLOB '*[^0-9]*' AND occurred_utc_ms <= '18446744073709551615')), occurred_utc_ms_state TEXT NOT NULL CHECK (occurred_utc_ms_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((occurred_utc_ms_state = 'available') = (occurred_utc_ms IS NOT NULL)), occurred_simulation TEXT NOT NULL CHECK (occurred_simulation IN ('running', 'paused', 'unavailable')),
    configuration_revision TEXT NOT NULL CHECK (length(configuration_revision) = 20 AND configuration_revision NOT GLOB '*[^0-9]*' AND configuration_revision <= '18446744073709551615'), boundary_order TEXT NOT NULL CHECK (length(boundary_order) = 20 AND boundary_order NOT GLOB '*[^0-9]*' AND boundary_order <= '18446744073709551615'), payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    protocol_minor INTEGER NOT NULL CHECK (protocol_minor BETWEEN 0 AND 65535), first_redelivered INTEGER NOT NULL CHECK (first_redelivered IN (0, 1)), committed_utc_ms INTEGER NOT NULL CHECK (committed_utc_ms >= 0),
    UNIQUE (plugin_session_id, event_seq)) STRICT;
INSERT INTO "events" VALUES(1,1,'00000000000000000001','job.configured','00000001000149000000','available',1,12345,'available',2,'00000001791676800000','available','running','00000000000000000008','00000000000000000101','{"occurred":{"boundaryOrder":"101","configurationRevision":"8","gameTime":{"clockId":"40000000-0000-4000-8000-000000000001","minutes":{"available":true,"value":"12345"}},"monotonicNs":{"available":true,"value":"1000149000000"},"simulation":"running","utcUnixMs":{"available":true,"value":"1791676800000"}},"record":{"cargo":{"available":true,"value":"Synthetic Cargo"},"cargoId":{"available":true,"value":"synthetic_cargo"},"cargoLoaded":{"available":true,"value":true},"cargoMass":{"available":true,"unit":"kg","value":18000},"cargoUnitCount":{"available":true,"value":18},"cargoUnitMass":{"available":true,"unit":"kg","value":1000},"deliveryDeadline":{"available":true,"unit":"min","value":"13000"},"destinationCity":{"available":true,"value":"Synthetic City B"},"destinationCityId":{"available":true,"value":"synthetic_city_b"},"destinationCompany":{"available":true,"value":"Synthetic Company B"},"destinationCompanyId":{"available":true,"value":"synthetic_company_b"},"expectedIncome":{"available":true,"value":{"currency":{"status":"unknown"},"raw":"12345","sdkType":"u64"}},"isSpecialJob":{"available":true,"value":false},"market":{"available":true,"value":"freight_market"},"plannedDistance":{"available":true,"unit":"m","value":152000},"sourceCity":{"available":true,"value":"Synthetic City A"},"sourceCityId":{"available":true,"value":"synthetic_city_a"},"sourceCompany":{"available":true,"value":"Synthetic Company A"},"sourceCompanyId":{"available":true,"value":"synthetic_company_a"},"type":"job.configured"}}',0,0,1791676801000);
INSERT INTO "events" VALUES(2,1,'00000000000000000002','job.delivered','00000001000149000000','available',1,12345,'available',2,'00000001791676800000','available','running','00000000000000000008','00000000000000000101','{"occurred":{"boundaryOrder":"101","configurationRevision":"8","gameTime":{"clockId":"40000000-0000-4000-8000-000000000001","minutes":{"available":true,"value":"12345"}},"monotonicNs":{"available":true,"value":"1000149000000"},"simulation":"running","utcUnixMs":{"available":true,"value":"1791676800000"}},"record":{"autoLoadUsed":{"available":true,"value":true},"autoParkUsed":{"available":true,"value":false},"cargoDamage":{"available":true,"unit":"fraction","value":0.0125},"deliveryDuration":{"available":true,"unit":"min","value":"471"},"distance":{"available":true,"unit":"m","value":151250.5},"earnedXp":{"available":true,"value":250},"revenue":{"available":true,"value":{"currency":{"status":"unknown"},"raw":"15000","sdkType":"s64"}},"type":"job.delivered"}}',0,0,1791676802000);
INSERT INTO "events" VALUES(3,1,'00000000000000000003','job.configured','00000001000149000000','available',1,12345,'available',2,'00000001791676800000','available','running','00000000000000000008','00000000000000000101','{"occurred":{"boundaryOrder":"101","configurationRevision":"8","gameTime":{"clockId":"40000000-0000-4000-8000-000000000001","minutes":{"available":true,"value":"12345"}},"monotonicNs":{"available":true,"value":"1000149000000"},"simulation":"running","utcUnixMs":{"available":true,"value":"1791676800000"}},"record":{"cargo":{"available":true,"value":"Synthetic Cargo"},"cargoId":{"available":true,"value":"synthetic_cargo"},"cargoLoaded":{"available":true,"value":true},"cargoMass":{"available":true,"unit":"kg","value":18000},"cargoUnitCount":{"available":true,"value":18},"cargoUnitMass":{"available":true,"unit":"kg","value":1000},"deliveryDeadline":{"available":true,"unit":"min","value":"13000"},"destinationCity":{"available":true,"value":"Synthetic City B"},"destinationCityId":{"available":true,"value":"synthetic_city_b"},"destinationCompany":{"available":true,"value":"Synthetic Company B"},"destinationCompanyId":{"available":true,"value":"synthetic_company_b"},"expectedIncome":{"available":true,"value":{"currency":{"code":"EUR","source":"scs-sdk-1.15/include/eurotrucks2/scssdk_telemetry_eut2.h#game-specific-units","status":"sdk-documented"},"raw":"12345","sdkType":"u64"}},"isSpecialJob":{"available":true,"value":false},"market":{"available":true,"value":"freight_market"},"plannedDistance":{"available":true,"unit":"m","value":152000},"sourceCity":{"available":true,"value":"Synthetic City A"},"sourceCityId":{"available":true,"value":"synthetic_city_a"},"sourceCompany":{"available":true,"value":"Synthetic Company A"},"sourceCompanyId":{"available":true,"value":"synthetic_company_a"},"type":"job.configured"}}',0,0,1791676803000);
INSERT INTO "events" VALUES(4,1,'00000000000000000006','job.configured','00000001000149000000','available',1,12345,'available',2,'00000001791676800000','available','running','00000000000000000008','00000000000000000101','{"occurred":{"boundaryOrder":"101","configurationRevision":"8","gameTime":{"clockId":"40000000-0000-4000-8000-000000000001","minutes":{"available":true,"value":"12345"}},"monotonicNs":{"available":true,"value":"1000149000000"},"simulation":"running","utcUnixMs":{"available":true,"value":"1791676800000"}},"record":{"cargo":{"available":true,"value":"Synthetic Cargo"},"cargoId":{"available":true,"value":"synthetic_cargo"},"cargoLoaded":{"available":true,"value":true},"cargoMass":{"available":true,"unit":"kg","value":18000},"cargoUnitCount":{"available":true,"value":18},"cargoUnitMass":{"available":true,"unit":"kg","value":1000},"deliveryDeadline":{"available":true,"unit":"min","value":"13000"},"destinationCity":{"available":true,"value":"Synthetic City B"},"destinationCityId":{"available":true,"value":"synthetic_city_b"},"destinationCompany":{"available":true,"value":"Synthetic Company B"},"destinationCompanyId":{"available":true,"value":"synthetic_company_b"},"expectedIncome":{"available":true,"value":{"currency":{"status":"unknown"},"raw":"12345","sdkType":"u64"}},"isSpecialJob":{"available":true,"value":false},"market":{"available":true,"value":"freight_market"},"plannedDistance":{"available":true,"unit":"m","value":152000},"sourceCity":{"available":true,"value":"Synthetic City A"},"sourceCityId":{"available":true,"value":"synthetic_city_a"},"sourceCompany":{"available":true,"value":"Synthetic Company A"},"sourceCompanyId":{"available":true,"value":"synthetic_company_a"},"type":"job.configured"}}',0,0,1791676806000);
INSERT INTO "events" VALUES(5,2,'00000000000000000001','job.configured','00000001000149000000','available',3,12345,'available',4,'00000001791676800000','available','running','00000000000000000008','00000000000000000101','{"occurred":{"boundaryOrder":"101","configurationRevision":"8","gameTime":{"clockId":"40000000-0000-4000-8000-000000000001","minutes":{"available":true,"value":"12345"}},"monotonicNs":{"available":true,"value":"1000149000000"},"simulation":"running","utcUnixMs":{"available":true,"value":"1791676800000"}},"record":{"cargo":{"available":true,"value":"Synthetic Cargo"},"cargoId":{"available":true,"value":"synthetic_cargo"},"cargoLoaded":{"available":true,"value":true},"cargoMass":{"available":true,"unit":"kg","value":18000},"cargoUnitCount":{"available":true,"value":18},"cargoUnitMass":{"available":true,"unit":"kg","value":1000},"deliveryDeadline":{"available":true,"unit":"min","value":"13000"},"destinationCity":{"available":true,"value":"Synthetic City B"},"destinationCityId":{"available":true,"value":"synthetic_city_b"},"destinationCompany":{"available":true,"value":"Synthetic Company B"},"destinationCompanyId":{"available":true,"value":"synthetic_company_b"},"expectedIncome":{"available":true,"value":{"currency":{"status":"unknown"},"raw":"12345","sdkType":"u64"}},"isSpecialJob":{"available":true,"value":false},"market":{"available":true,"value":"freight_market"},"plannedDistance":{"available":true,"unit":"m","value":152000},"sourceCity":{"available":true,"value":"Synthetic City A"},"sourceCityId":{"available":true,"value":"synthetic_city_a"},"sourceCompany":{"available":true,"value":"Synthetic Company A"},"sourceCompanyId":{"available":true,"value":"synthetic_company_a"},"type":"job.configured"}}',0,0,1791676811000);
CREATE TABLE event_gaps (id INTEGER PRIMARY KEY, plugin_session_ref INTEGER NOT NULL REFERENCES plugin_sessions (id),
    first_event_seq TEXT NOT NULL CHECK ((length(first_event_seq) = 20 AND first_event_seq NOT GLOB '*[^0-9]*' AND first_event_seq <= '18446744073709551615') AND first_event_seq > '00000000000000000000' AND first_event_seq <= '18446744073709551614'), last_event_seq TEXT NOT NULL CHECK ((length(last_event_seq) = 20 AND last_event_seq NOT GLOB '*[^0-9]*' AND last_event_seq <= '18446744073709551615') AND last_event_seq > '00000000000000000000' AND last_event_seq <= '18446744073709551614'),
    cause_offline TEXT NOT NULL CHECK (length(cause_offline) = 20 AND cause_offline NOT GLOB '*[^0-9]*' AND cause_offline <= '18446744073709551615'), cause_no_durable_consumer TEXT NOT NULL CHECK (length(cause_no_durable_consumer) = 20 AND cause_no_durable_consumer NOT GLOB '*[^0-9]*' AND cause_no_durable_consumer <= '18446744073709551615'), cause_queue_count TEXT NOT NULL CHECK (length(cause_queue_count) = 20 AND cause_queue_count NOT GLOB '*[^0-9]*' AND cause_queue_count <= '18446744073709551615'), cause_queue_bytes TEXT NOT NULL CHECK (length(cause_queue_bytes) = 20 AND cause_queue_bytes NOT GLOB '*[^0-9]*' AND cause_queue_bytes <= '18446744073709551615'), cause_retention_expired TEXT NOT NULL CHECK (length(cause_retention_expired) = 20 AND cause_retention_expired NOT GLOB '*[^0-9]*' AND cause_retention_expired <= '18446744073709551615'), cause_encoding_failed TEXT NOT NULL CHECK (length(cause_encoding_failed) = 20 AND cause_encoding_failed NOT GLOB '*[^0-9]*' AND cause_encoding_failed <= '18446744073709551615'),
    first_lost_monotonic_ns TEXT CHECK ((length(first_lost_monotonic_ns) = 20 AND first_lost_monotonic_ns NOT GLOB '*[^0-9]*' AND first_lost_monotonic_ns <= '18446744073709551615')), first_lost_monotonic_ns_state TEXT NOT NULL CHECK (first_lost_monotonic_ns_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((first_lost_monotonic_ns_state = 'available') = (first_lost_monotonic_ns IS NOT NULL)), last_lost_monotonic_ns TEXT CHECK ((length(last_lost_monotonic_ns) = 20 AND last_lost_monotonic_ns NOT GLOB '*[^0-9]*' AND last_lost_monotonic_ns <= '18446744073709551615')), last_lost_monotonic_ns_state TEXT NOT NULL CHECK (last_lost_monotonic_ns_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((last_lost_monotonic_ns_state = 'available') = (last_lost_monotonic_ns IS NOT NULL)),
    source_clock_ref INTEGER NOT NULL REFERENCES clocks (id), redelivered INTEGER NOT NULL CHECK (redelivered IN (0, 1)),
    committed_utc_ms INTEGER NOT NULL CHECK (committed_utc_ms >= 0), CHECK (first_event_seq <= last_event_seq), UNIQUE (plugin_session_ref, first_event_seq, last_event_seq)) STRICT;
INSERT INTO "event_gaps" VALUES(1,1,'00000000000000000004','00000000000000000005','00000000000000000000','00000000000000000000','00000000000000000002','00000000000000000000','00000000000000000000','00000000000000000000',NULL,'not-observed',NULL,'not-observed',1,0,1791676805000);
CREATE TABLE truck_configurations (id INTEGER PRIMARY KEY, event_ref INTEGER NOT NULL UNIQUE REFERENCES events (id),
    brand_id TEXT, brand_id_state TEXT NOT NULL CHECK (brand_id_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((brand_id_state = 'available') = (brand_id IS NOT NULL)), brand TEXT, brand_state TEXT NOT NULL CHECK (brand_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((brand_state = 'available') = (brand IS NOT NULL)), model_id TEXT, model_id_state TEXT NOT NULL CHECK (model_id_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((model_id_state = 'available') = (model_id IS NOT NULL)), model_name TEXT, model_name_state TEXT NOT NULL CHECK (model_name_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((model_name_state = 'available') = (model_name IS NOT NULL)), fuel_capacity_l REAL, fuel_capacity_l_state TEXT NOT NULL CHECK (fuel_capacity_l_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((fuel_capacity_l_state = 'available') = (fuel_capacity_l IS NOT NULL)),
    license_plate TEXT, license_plate_state TEXT NOT NULL CHECK (license_plate_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((license_plate_state = 'available') = (license_plate IS NOT NULL)), plate_country_id TEXT, plate_country_id_state TEXT NOT NULL CHECK (plate_country_id_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((plate_country_id_state = 'available') = (plate_country_id IS NOT NULL)), plate_country TEXT, plate_country_state TEXT NOT NULL CHECK (plate_country_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((plate_country_state = 'available') = (plate_country IS NOT NULL))) STRICT;
CREATE TABLE trailer_configurations (id INTEGER PRIMARY KEY, event_ref INTEGER NOT NULL UNIQUE REFERENCES events (id),
    slot_index INTEGER NOT NULL CHECK (slot_index BETWEEN 0 AND 9),
    trailer_id TEXT, trailer_id_state TEXT NOT NULL CHECK (trailer_id_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((trailer_id_state = 'available') = (trailer_id IS NOT NULL)), body_type TEXT, body_type_state TEXT NOT NULL CHECK (body_type_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((body_type_state = 'available') = (body_type IS NOT NULL)), chain_type TEXT, chain_type_state TEXT NOT NULL CHECK (chain_type_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((chain_type_state = 'available') = (chain_type IS NOT NULL)), cargo_accessory_id TEXT, cargo_accessory_id_state TEXT NOT NULL CHECK (cargo_accessory_id_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((cargo_accessory_id_state = 'available') = (cargo_accessory_id IS NOT NULL)), brand_id TEXT, brand_id_state TEXT NOT NULL CHECK (brand_id_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((brand_id_state = 'available') = (brand_id IS NOT NULL)), brand TEXT, brand_state TEXT NOT NULL CHECK (brand_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((brand_state = 'available') = (brand IS NOT NULL)), name TEXT, name_state TEXT NOT NULL CHECK (name_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((name_state = 'available') = (name IS NOT NULL)), license_plate TEXT, license_plate_state TEXT NOT NULL CHECK (license_plate_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((license_plate_state = 'available') = (license_plate IS NOT NULL)), plate_country_id TEXT, plate_country_id_state TEXT NOT NULL CHECK (plate_country_id_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((plate_country_id_state = 'available') = (plate_country_id IS NOT NULL)), plate_country TEXT, plate_country_state TEXT NOT NULL CHECK (plate_country_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((plate_country_state = 'available') = (plate_country IS NOT NULL))) STRICT;
CREATE TABLE event_amounts (event_ref INTEGER PRIMARY KEY REFERENCES events (id), amount_raw TEXT CHECK ((amount_sdk_type = 'u64' AND (amount_raw = '0' OR (amount_raw GLOB '[1-9]*' AND length(amount_raw) <= 20 AND substr(amount_raw, 2) NOT GLOB '*[^0-9]*'))) OR (amount_sdk_type = 's64' AND (amount_raw = '0' OR (amount_raw GLOB '[1-9]*' AND length(amount_raw) <= 19 AND substr(amount_raw, 2) NOT GLOB '*[^0-9]*') OR (amount_raw GLOB '-[1-9]*' AND length(amount_raw) <= 20 AND substr(amount_raw, 2) NOT GLOB '*[^0-9]*')))), amount_sdk_type TEXT CHECK (amount_sdk_type IN ('s64', 'u64')), amount_currency_status TEXT CHECK (amount_currency_status IN ('unknown', 'sdk-documented')), amount_currency_code TEXT CHECK (amount_currency_code GLOB '[A-Z][A-Z][A-Z]'), amount_currency_source TEXT CHECK (length(amount_currency_source) BETWEEN 1 AND 128), amount_state TEXT NOT NULL CHECK (amount_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((amount_state = 'available') = (amount_raw IS NOT NULL) AND (amount_raw IS NULL) = (amount_sdk_type IS NULL) AND (amount_raw IS NULL) = (amount_currency_status IS NULL)) CHECK ((amount_currency_status IS 'sdk-documented') = (amount_currency_code IS NOT NULL) AND (amount_currency_code IS NULL) = (amount_currency_source IS NULL))) STRICT;
INSERT INTO "event_amounts" VALUES(2,'15000','s64','unknown',NULL,NULL,'available');
CREATE TABLE job_deliveries (event_ref INTEGER PRIMARY KEY REFERENCES events (id),
    earned_xp INTEGER CHECK (earned_xp BETWEEN -2147483648 AND 2147483647), earned_xp_state TEXT NOT NULL CHECK (earned_xp_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((earned_xp_state = 'available') = (earned_xp IS NOT NULL)), cargo_damage REAL, cargo_damage_state TEXT NOT NULL CHECK (cargo_damage_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((cargo_damage_state = 'available') = (cargo_damage IS NOT NULL)), distance_m REAL, distance_m_state TEXT NOT NULL CHECK (distance_m_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((distance_m_state = 'available') = (distance_m IS NOT NULL)),
    delivery_duration_minutes INTEGER CHECK (delivery_duration_minutes BETWEEN 0 AND 4294967295), delivery_duration_minutes_state TEXT NOT NULL CHECK (delivery_duration_minutes_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((delivery_duration_minutes_state = 'available') = (delivery_duration_minutes IS NOT NULL)), auto_park_used INTEGER CHECK (auto_park_used IN (0, 1)), auto_park_used_state TEXT NOT NULL CHECK (auto_park_used_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((auto_park_used_state = 'available') = (auto_park_used IS NOT NULL)), auto_load_used INTEGER CHECK (auto_load_used IN (0, 1)), auto_load_used_state TEXT NOT NULL CHECK (auto_load_used_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((auto_load_used_state = 'available') = (auto_load_used IS NOT NULL))) STRICT;
INSERT INTO "job_deliveries" VALUES(2,250,'available',0.0125,'available',151250.5,'available',471,'available',0,'available',1,'available');
CREATE TABLE trip_trailers (trip_ref INTEGER NOT NULL REFERENCES trips (id), trailer_configuration_ref INTEGER NOT NULL REFERENCES trailer_configurations (id),
    PRIMARY KEY (trip_ref, trailer_configuration_ref)) STRICT;
CREATE TABLE event_attributions (event_ref INTEGER PRIMARY KEY REFERENCES events (id), trip_ref INTEGER REFERENCES trips (id),
    attribution TEXT NOT NULL CHECK (attribution IN ('trip', 'trip-before-loaded', 'free-driving', 'ambiguous')),
    CHECK ((trip_ref IS NULL) = (attribution IN ('free-driving', 'ambiguous')))) STRICT;
INSERT INTO "event_attributions" VALUES(2,1,'trip');
CREATE TABLE completeness_intervals (id INTEGER PRIMARY KEY, plugin_session_ref INTEGER NOT NULL REFERENCES plugin_sessions (id), trip_ref INTEGER REFERENCES trips (id),
    kind TEXT NOT NULL CHECK (kind IN ('event-loss', 'not-connected', 'storage-unavailable', 'sample-loss', 'discontinuity', 'restore-loss')),
    start_utc_ms INTEGER CHECK (start_utc_ms >= 0), end_utc_ms INTEGER CHECK (end_utc_ms >= start_utc_ms),
    start_monotonic_ns TEXT CHECK (start_monotonic_ns IS NULL OR (length(start_monotonic_ns) = 20 AND start_monotonic_ns NOT GLOB '*[^0-9]*' AND start_monotonic_ns <= '18446744073709551615')), end_monotonic_ns TEXT CHECK (end_monotonic_ns IS NULL OR (length(end_monotonic_ns) = 20 AND end_monotonic_ns NOT GLOB '*[^0-9]*' AND end_monotonic_ns <= '18446744073709551615')), source_clock_ref INTEGER REFERENCES clocks (id),
    first_event_seq TEXT CHECK (first_event_seq IS NULL OR (length(first_event_seq) = 20 AND first_event_seq NOT GLOB '*[^0-9]*' AND first_event_seq <= '18446744073709551615')), last_event_seq TEXT CHECK (last_event_seq IS NULL OR (length(last_event_seq) = 20 AND last_event_seq NOT GLOB '*[^0-9]*' AND last_event_seq <= '18446744073709551615')), detail_json TEXT CHECK (json_valid(detail_json)),
    created_utc_ms INTEGER NOT NULL CHECK (created_utc_ms >= 0), CHECK (end_monotonic_ns >= start_monotonic_ns),
    CHECK ((start_monotonic_ns IS NULL AND end_monotonic_ns IS NULL) OR source_clock_ref IS NOT NULL), CHECK (last_event_seq >= first_event_seq)) STRICT;
INSERT INTO "completeness_intervals" VALUES(1,1,2,'event-loss',NULL,NULL,NULL,NULL,NULL,'00000000000000000004','00000000000000000005','{"cause":"gap"}',1791676805000);
INSERT INTO "completeness_intervals" VALUES(2,2,4,'discontinuity',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'{"atEventSeq":"1","cause":"restart","continuationOf":"70000000-0000-4000-8000-000000000003","decision":"not-merged"}',1791676811000);
INSERT INTO "completeness_intervals" VALUES(3,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(4,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(5,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(6,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(7,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(8,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(9,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(10,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(11,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(12,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(13,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(14,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(15,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(16,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(17,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(18,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(19,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(20,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(21,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(22,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(23,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(24,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(25,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(26,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(27,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(28,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(29,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(30,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(31,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(32,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(33,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(34,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(35,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(36,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(37,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(38,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(39,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(40,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(41,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(42,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(43,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(44,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(45,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(46,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(47,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(48,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(49,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(50,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(51,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(52,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(53,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(54,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(55,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(56,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(57,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(58,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(59,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(60,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(61,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(62,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(63,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(64,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(65,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(66,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(67,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(68,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(69,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(70,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(71,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(72,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(73,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(74,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(75,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(76,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(77,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(78,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(79,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(80,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(81,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(82,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(83,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(84,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(85,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(86,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(87,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(88,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(89,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(90,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(91,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(92,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(93,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(94,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(95,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(96,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(97,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(98,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(99,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(100,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(101,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(102,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(103,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(104,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(105,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(106,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(107,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(108,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(109,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(110,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(111,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(112,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(113,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(114,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(115,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(116,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(117,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(118,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(119,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(120,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(121,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
INSERT INTO "completeness_intervals" VALUES(122,1,2,'sample-loss',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793966400000);
CREATE TABLE samples (id INTEGER PRIMARY KEY, plugin_session_ref INTEGER NOT NULL REFERENCES plugin_sessions (id), trip_ref INTEGER REFERENCES trips (id),
    utc_ms INTEGER NOT NULL CHECK (utc_ms >= 0), source_clock_ref INTEGER NOT NULL REFERENCES clocks (id), monotonic_ns INTEGER NOT NULL CHECK (monotonic_ns >= 0),
    game_minutes INTEGER CHECK (game_minutes BETWEEN 0 AND 4294967295), game_clock_ref INTEGER REFERENCES clocks (id),
    speed_mps REAL, fuel_l REAL, avg_consumption_l100km REAL, range_m REAL, engine_rpm REAL, gear INTEGER, odometer_m REAL, x REAL, y REAL, z REAL,
    not_supported_mask INTEGER NOT NULL DEFAULT 0 CHECK (not_supported_mask BETWEEN 0 AND 511),
    invalid_mask INTEGER NOT NULL DEFAULT 0 CHECK (invalid_mask BETWEEN 0 AND 511),
    CHECK (game_minutes IS NULL OR game_clock_ref IS NOT NULL), CHECK ((x IS NULL) = (y IS NULL) AND (y IS NULL) = (z IS NULL)), CHECK ((not_supported_mask & invalid_mask) = 0),
    CHECK (((not_supported_mask | invalid_mask) & 1) = 0 OR speed_mps IS NULL), CHECK (((not_supported_mask | invalid_mask) & 2) = 0 OR fuel_l IS NULL), CHECK (((not_supported_mask | invalid_mask) & 4) = 0 OR avg_consumption_l100km IS NULL), CHECK (((not_supported_mask | invalid_mask) & 8) = 0 OR range_m IS NULL), CHECK (((not_supported_mask | invalid_mask) & 16) = 0 OR engine_rpm IS NULL), CHECK (((not_supported_mask | invalid_mask) & 32) = 0 OR gear IS NULL), CHECK (((not_supported_mask | invalid_mask) & 64) = 0 OR odometer_m IS NULL), CHECK (((not_supported_mask | invalid_mask) & 128) = 0 OR x IS NULL), CHECK (((not_supported_mask | invalid_mask) & 128) = 0 OR y IS NULL), CHECK (((not_supported_mask | invalid_mask) & 128) = 0 OR z IS NULL), CHECK (((not_supported_mask | invalid_mask) & 256) = 0 OR game_minutes IS NULL)) STRICT;
INSERT INTO "samples" VALUES(1,1,1,1791676801000,1,1001100000000,12345,2,22.25,410.25,32.5,1263000,1450.5,12,1234590,-31212.25,42.5,18801.5,0,0);
INSERT INTO "samples" VALUES(2,2,4,1791676811000,3,1011000000000,NULL,NULL,0,NULL,NULL,NULL,600,0,NULL,NULL,NULL,NULL,2,4);
CREATE TABLE "job_configurations" (id INTEGER PRIMARY KEY, plugin_session_ref INTEGER NOT NULL REFERENCES plugin_sessions (id),
    source TEXT NOT NULL CHECK (source IN ('event', 'checkpoint')), event_ref INTEGER UNIQUE REFERENCES events (id),
    checkpoint_next_event_seq TEXT CHECK (checkpoint_next_event_seq IS NULL OR ((length(checkpoint_next_event_seq) = 20 AND checkpoint_next_event_seq NOT GLOB '*[^0-9]*' AND checkpoint_next_event_seq <= '18446744073709551615') AND checkpoint_next_event_seq > '00000000000000000000')),
    source_city_id TEXT, source_city_id_state TEXT NOT NULL CHECK (source_city_id_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((source_city_id_state = 'available') = (source_city_id IS NOT NULL)), source_city TEXT, source_city_state TEXT NOT NULL CHECK (source_city_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((source_city_state = 'available') = (source_city IS NOT NULL)), source_company_id TEXT, source_company_id_state TEXT NOT NULL CHECK (source_company_id_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((source_company_id_state = 'available') = (source_company_id IS NOT NULL)), source_company TEXT, source_company_state TEXT NOT NULL CHECK (source_company_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((source_company_state = 'available') = (source_company IS NOT NULL)), destination_city_id TEXT, destination_city_id_state TEXT NOT NULL CHECK (destination_city_id_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((destination_city_id_state = 'available') = (destination_city_id IS NOT NULL)), destination_city TEXT, destination_city_state TEXT NOT NULL CHECK (destination_city_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((destination_city_state = 'available') = (destination_city IS NOT NULL)), destination_company_id TEXT, destination_company_id_state TEXT NOT NULL CHECK (destination_company_id_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((destination_company_id_state = 'available') = (destination_company_id IS NOT NULL)), destination_company TEXT, destination_company_state TEXT NOT NULL CHECK (destination_company_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((destination_company_state = 'available') = (destination_company IS NOT NULL)), cargo_id TEXT, cargo_id_state TEXT NOT NULL CHECK (cargo_id_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((cargo_id_state = 'available') = (cargo_id IS NOT NULL)), cargo TEXT, cargo_state TEXT NOT NULL CHECK (cargo_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((cargo_state = 'available') = (cargo IS NOT NULL)),
    cargo_mass_kg REAL, cargo_mass_kg_state TEXT NOT NULL CHECK (cargo_mass_kg_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((cargo_mass_kg_state = 'available') = (cargo_mass_kg IS NOT NULL)), cargo_unit_mass_kg REAL, cargo_unit_mass_kg_state TEXT NOT NULL CHECK (cargo_unit_mass_kg_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((cargo_unit_mass_kg_state = 'available') = (cargo_unit_mass_kg IS NOT NULL)), cargo_unit_count INTEGER CHECK (cargo_unit_count BETWEEN 0 AND 4294967295), cargo_unit_count_state TEXT NOT NULL CHECK (cargo_unit_count_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((cargo_unit_count_state = 'available') = (cargo_unit_count IS NOT NULL)),
    market TEXT, market_state TEXT NOT NULL CHECK (market_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((market_state = 'available') = (market IS NOT NULL)), is_special_job INTEGER CHECK (is_special_job IN (0, 1)), is_special_job_state TEXT NOT NULL CHECK (is_special_job_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((is_special_job_state = 'available') = (is_special_job IS NOT NULL)), cargo_loaded INTEGER CHECK (cargo_loaded IN (0, 1)), cargo_loaded_state TEXT NOT NULL CHECK (cargo_loaded_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((cargo_loaded_state = 'available') = (cargo_loaded IS NOT NULL)), planned_distance_m INTEGER CHECK (planned_distance_m >= 0), planned_distance_m_state TEXT NOT NULL CHECK (planned_distance_m_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((planned_distance_m_state = 'available') = (planned_distance_m IS NOT NULL)),
    expected_income_raw TEXT CHECK ((expected_income_sdk_type = 'u64' AND (expected_income_raw = '0' OR (expected_income_raw GLOB '[1-9]*' AND length(expected_income_raw) <= 20 AND substr(expected_income_raw, 2) NOT GLOB '*[^0-9]*'))) OR (expected_income_sdk_type = 's64' AND (expected_income_raw = '0' OR (expected_income_raw GLOB '[1-9]*' AND length(expected_income_raw) <= 19 AND substr(expected_income_raw, 2) NOT GLOB '*[^0-9]*') OR (expected_income_raw GLOB '-[1-9]*' AND length(expected_income_raw) <= 20 AND substr(expected_income_raw, 2) NOT GLOB '*[^0-9]*')))), expected_income_sdk_type TEXT CHECK (expected_income_sdk_type IN ('s64', 'u64')), expected_income_currency_status TEXT CHECK (expected_income_currency_status IN ('unknown', 'sdk-documented')), expected_income_currency_code TEXT CHECK (expected_income_currency_code GLOB '[A-Z][A-Z][A-Z]'), expected_income_currency_source TEXT CHECK (length(expected_income_currency_source) BETWEEN 1 AND 128), expected_income_state TEXT NOT NULL CHECK (expected_income_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((expected_income_state = 'available') = (expected_income_raw IS NOT NULL) AND (expected_income_raw IS NULL) = (expected_income_sdk_type IS NULL) AND (expected_income_raw IS NULL) = (expected_income_currency_status IS NULL)) CHECK ((expected_income_currency_status IS 'sdk-documented') = (expected_income_currency_code IS NOT NULL) AND (expected_income_currency_code IS NULL) = (expected_income_currency_source IS NULL)), delivery_deadline_minutes INTEGER CHECK (delivery_deadline_minutes BETWEEN 0 AND 4294967295), delivery_deadline_minutes_state TEXT NOT NULL CHECK (delivery_deadline_minutes_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((delivery_deadline_minutes_state = 'available') = (delivery_deadline_minutes IS NOT NULL)),
    CHECK ((source = 'event') = (event_ref IS NOT NULL)), CHECK ((source = 'checkpoint') = (checkpoint_next_event_seq IS NOT NULL)),
    UNIQUE (plugin_session_ref, checkpoint_next_event_seq)) STRICT;
INSERT INTO "job_configurations" VALUES(1,1,'event',1,NULL,'synthetic_city_a','available','Synthetic City A','available','synthetic_company_a','available','Synthetic Company A','available','synthetic_city_b','available','Synthetic City B','available','synthetic_company_b','available','Synthetic Company B','available','synthetic_cargo','available','Synthetic Cargo','available',18000,'available',1000,'available',18,'available','freight_market','available',0,'available',1,'available',152000,'available','12345','u64','unknown',NULL,NULL,'available',13000,'available');
INSERT INTO "job_configurations" VALUES(2,1,'event',3,NULL,'synthetic_city_a','available','Synthetic City A','available','synthetic_company_a','available','Synthetic Company A','available','synthetic_city_b','available','Synthetic City B','available','synthetic_company_b','available','Synthetic Company B','available','synthetic_cargo','available','Synthetic Cargo','available',18000,'available',1000,'available',18,'available','freight_market','available',0,'available',1,'available',152000,'available','12345','u64','sdk-documented','EUR','scs-sdk-1.15/include/eurotrucks2/scssdk_telemetry_eut2.h#game-specific-units','available',13000,'available');
INSERT INTO "job_configurations" VALUES(3,1,'event',4,NULL,'synthetic_city_a','available','Synthetic City A','available','synthetic_company_a','available','Synthetic Company A','available','synthetic_city_b','available','Synthetic City B','available','synthetic_company_b','available','Synthetic Company B','available','synthetic_cargo','available','Synthetic Cargo','available',18000,'available',1000,'available',18,'available','freight_market','available',0,'available',1,'available',152000,'available','12345','u64','unknown',NULL,NULL,'available',13000,'available');
INSERT INTO "job_configurations" VALUES(4,2,'event',5,NULL,'synthetic_city_a','available','Synthetic City A','available','synthetic_company_a','available','Synthetic Company A','available','synthetic_city_b','available','Synthetic City B','available','synthetic_company_b','available','Synthetic Company B','available','synthetic_cargo','available','Synthetic Cargo','available',18000,'available',1000,'available',18,'available','freight_market','available',0,'available',1,'available',152000,'available','12345','u64','unknown',NULL,NULL,'available',13000,'available');
INSERT INTO "job_configurations" VALUES(5,2,'checkpoint',NULL,'00000000000000000002','synthetic_city_a','available','Synthetic City A','available','synthetic_company_a','available','Synthetic Company A','available','synthetic_city_b','available','Synthetic City B','available','synthetic_company_b','available','Synthetic Company B','available','synthetic_cargo','available','Synthetic Cargo','available',18000,'available',1000,'available',18,'available','freight_market','available',0,'available',1,'available',152000,'available',NULL,NULL,NULL,NULL,NULL,'not-observed',13000,'available');
CREATE TABLE "trips" (id INTEGER PRIMARY KEY, trip_uuid TEXT NOT NULL CHECK (trip_uuid GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]') UNIQUE, plugin_session_ref INTEGER NOT NULL REFERENCES plugin_sessions (id),
    game TEXT NOT NULL CHECK (game IN ('ets2', 'ats')), game_mode TEXT NOT NULL CHECK (game_mode IN ('single-player', 'truckersmp', 'unknown', 'convoy')),
    game_mode_method TEXT NOT NULL CHECK (game_mode_method IN ('module-scan', 'process-scan', 'none')), game_mode_confidence TEXT NOT NULL CHECK (game_mode_confidence IN ('strong', 'weak', 'none')),
    game_mode_ambiguous INTEGER NOT NULL DEFAULT 0 CHECK (game_mode_ambiguous IN (0, 1)),
    job_configuration_ref INTEGER NOT NULL REFERENCES job_configurations (id), truck_configuration_ref INTEGER REFERENCES truck_configurations (id),
    opened_event_ref INTEGER REFERENCES events (id), opened_by TEXT NOT NULL CHECK (opened_by IN ('event', 'checkpoint')),
    outcome TEXT NOT NULL CHECK (outcome IN ('open', 'delivered', 'cancelled', 'none')), outcome_event_ref INTEGER REFERENCES events (id),
    close_reason TEXT CHECK (close_reason IN ('outcome', 'configuration-cleared', 'different-job', 'restart', 'discontinuity', 'gap')),
    recording_completeness TEXT NOT NULL CHECK (recording_completeness IN ('complete', 'partial', 'unknown')),
    started_utc_ms INTEGER NOT NULL CHECK (started_utc_ms >= 0), ended_utc_ms INTEGER CHECK (ended_utc_ms >= started_utc_ms),
    observed_distance_m REAL CHECK (observed_distance_m >= 0), observed_distance_m_state TEXT NOT NULL CHECK (observed_distance_m_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((observed_distance_m_state = 'available') = (observed_distance_m IS NOT NULL)),
    created_utc_ms INTEGER NOT NULL CHECK (created_utc_ms >= 0), updated_utc_ms INTEGER NOT NULL CHECK (updated_utc_ms >= created_utc_ms),
    fuel_used_l REAL CHECK (fuel_used_l IS NULL OR fuel_used_l >= 0),
    fuel_used_l_state TEXT NOT NULL DEFAULT 'not-observed' CHECK (fuel_used_l_state IN ('available', 'not-observed', 'not-supported', 'invalid')) CHECK ((fuel_used_l_state = 'available') = (fuel_used_l IS NOT NULL)),
    closed_by_session_ref INTEGER REFERENCES plugin_sessions (id),
    closed_by_event_seq TEXT CHECK (closed_by_event_seq IS NULL OR ((length(closed_by_event_seq) = 20 AND closed_by_event_seq NOT GLOB '*[^0-9]*' AND closed_by_event_seq <= '18446744073709551615') AND closed_by_event_seq > '00000000000000000000' AND closed_by_event_seq <= '18446744073709551614')), is_hard_mode INTEGER NOT NULL DEFAULT 0 CHECK (is_hard_mode IN (0, 1)), hard_mode_details TEXT CHECK (hard_mode_details IS NULL OR (length(hard_mode_details) <= 16384 AND json_valid(hard_mode_details))),
    CHECK ((outcome = 'open') = (close_reason IS NULL)), CHECK ((outcome IN ('delivered', 'cancelled')) = (outcome_event_ref IS NOT NULL)),
    CHECK ((outcome = 'open') = (ended_utc_ms IS NULL)),
    CHECK ((opened_by = 'event' AND opened_event_ref IS NOT NULL) OR (opened_by = 'checkpoint' AND opened_event_ref IS NULL)),
    CHECK ((closed_by_session_ref IS NULL) = (closed_by_event_seq IS NULL)), CHECK (closed_by_event_seq IS NULL OR outcome <> 'open')) STRICT;
INSERT INTO "trips" VALUES(1,'70000000-0000-4000-8000-000000000001',1,'ets2','single-player','module-scan','weak',0,1,NULL,1,'event','delivered',2,'outcome','complete',1791676800000,1791676802000,151000.25,'available',1791676801000,1791676802000,42.5,'available',1,'00000000000000000002',0,NULL);
INSERT INTO "trips" VALUES(2,'70000000-0000-4000-8000-000000000002',1,'ets2','single-player','module-scan','weak',0,2,NULL,3,'event','none',NULL,'gap','partial',1791676803000,1791676805000,NULL,'not-observed',1791676803000,1791676805000,NULL,'not-observed',1,'00000000000000000004',0,NULL);
INSERT INTO "trips" VALUES(3,'70000000-0000-4000-8000-000000000003',1,'ets2','single-player','module-scan','weak',0,3,NULL,4,'event','none',NULL,'restart','partial',1791676806000,1791676807000,0,'available',1791676806000,1791676811000,0,'available',2,'00000000000000000001',0,NULL);
INSERT INTO "trips" VALUES(4,'70000000-0000-4000-8000-000000000004',2,'ets2','unknown','none','none',0,4,NULL,5,'event','open',NULL,NULL,'partial',1791676810000,NULL,NULL,'not-observed',1791676811000,1791676811000,NULL,'not-supported',NULL,NULL,0,NULL);
CREATE TABLE observation_closes(trip_ref INTEGER PRIMARY KEY REFERENCES trips(id)) STRICT;
CREATE TABLE logical_trips (
    id INTEGER PRIMARY KEY REFERENCES trips(id), trip_uuid TEXT NOT NULL UNIQUE REFERENCES trips(trip_uuid),
    latest_trip_ref INTEGER NOT NULL REFERENCES trips(id), game TEXT NOT NULL CHECK(game IN ('ets2','ats')),
    profile_scope TEXT, fingerprint TEXT, canonical_constraints TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(canonical_constraints)),
    retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)),
    hard_mode_lost INTEGER NOT NULL DEFAULT 0 CHECK(hard_mode_lost IN (0,1)), progress_head INTEGER REFERENCES logical_progress(id),
    accounting_rebased INTEGER NOT NULL DEFAULT 0 CHECK(accounting_rebased IN (0,1)), reconciliation_unknown INTEGER NOT NULL DEFAULT 0 CHECK(reconciliation_unknown IN (0,1)),
    member_count INTEGER NOT NULL DEFAULT 1, mode_ambiguous INTEGER NOT NULL DEFAULT 0 CHECK(mode_ambiguous IN (0,1)),
    first_loss_json TEXT CHECK(first_loss_json IS NULL OR json_valid(first_loss_json)),
    interrupted INTEGER NOT NULL DEFAULT 0 CHECK(interrupted IN (0,1))) STRICT;
INSERT INTO "logical_trips" VALUES(1,'70000000-0000-4000-8000-000000000001',1,'ets2',NULL,NULL,'{}',1,1,NULL,0,0,1,0,NULL,0);
INSERT INTO "logical_trips" VALUES(2,'70000000-0000-4000-8000-000000000002',2,'ets2',NULL,NULL,'{}',1,1,NULL,0,0,1,0,NULL,0);
INSERT INTO "logical_trips" VALUES(3,'70000000-0000-4000-8000-000000000003',3,'ets2',NULL,NULL,'{}',1,1,NULL,0,0,1,0,NULL,0);
INSERT INTO "logical_trips" VALUES(4,'70000000-0000-4000-8000-000000000004',4,'ets2',NULL,NULL,'{}',1,1,NULL,0,0,1,0,NULL,0);
CREATE TABLE logical_memberships (trip_ref INTEGER PRIMARY KEY REFERENCES trips(id), logical_ref INTEGER NOT NULL REFERENCES logical_trips(id),
    previous_logical_ref INTEGER REFERENCES logical_trips(id), joined_after_revision INTEGER,
    decision_key TEXT NOT NULL UNIQUE, observation_key TEXT, proof_json TEXT CHECK(proof_json IS NULL OR json_valid(proof_json))) STRICT;
INSERT INTO "logical_memberships" VALUES(1,1,NULL,NULL,'migration-v4:70000000-0000-4000-8000-000000000001',NULL,NULL);
INSERT INTO "logical_memberships" VALUES(2,2,NULL,NULL,'migration-v4:70000000-0000-4000-8000-000000000002',NULL,NULL);
INSERT INTO "logical_memberships" VALUES(3,3,NULL,NULL,'migration-v4:70000000-0000-4000-8000-000000000003',NULL,NULL);
INSERT INTO "logical_memberships" VALUES(4,4,NULL,NULL,'migration-v4:70000000-0000-4000-8000-000000000004',NULL,NULL);
CREATE TABLE logical_trucks(id INTEGER PRIMARY KEY, identity_key TEXT NOT NULL UNIQUE) STRICT;
CREATE TABLE logical_progress (
    id INTEGER PRIMARY KEY, logical_ref INTEGER NOT NULL REFERENCES logical_trips(id), trip_ref INTEGER NOT NULL REFERENCES trips(id),
    anchor_sample_ref INTEGER NOT NULL REFERENCES samples(id), sample_ref INTEGER REFERENCES samples(id), bound_sample_ref INTEGER REFERENCES samples(id), prefix_ref INTEGER REFERENCES logical_progress(id), start_ref INTEGER REFERENCES logical_progress(id),
    cut_odometer_m REAL, truck_ref INTEGER REFERENCES logical_trucks(id), odometer_m REAL, start_odometer_m REAL, distance_m REAL, fuel_used_l REAL,
    UNIQUE(sample_ref)) STRICT;
CREATE TABLE logical_projection_states(id INTEGER PRIMARY KEY,row_json TEXT NOT NULL UNIQUE CHECK(json_valid(row_json))) STRICT;
INSERT INTO "logical_projection_states" VALUES(1,'{"id":{"$integer":"1"},"trip_uuid":"70000000-0000-4000-8000-000000000001","plugin_session_ref":{"$integer":"1"},"game":"ets2","game_mode":"single-player","game_mode_method":"module-scan","game_mode_confidence":"weak","game_mode_ambiguous":{"$integer":"0"},"job_configuration_ref":{"$integer":"1"},"truck_configuration_ref":null,"opened_event_ref":{"$integer":"1"},"opened_by":"event","outcome":"delivered","outcome_event_ref":{"$integer":"2"},"close_reason":"outcome","recording_completeness":"complete","started_utc_ms":{"$integer":"1791676800000"},"ended_utc_ms":{"$integer":"1791676802000"},"observed_distance_m":151000.25,"observed_distance_m_state":"available","created_utc_ms":{"$integer":"1791676801000"},"updated_utc_ms":{"$integer":"1791676802000"},"fuel_used_l":42.5,"fuel_used_l_state":"available","closed_by_session_ref":{"$integer":"1"},"closed_by_event_seq":"00000000000000000002","is_hard_mode":{"$integer":"0"},"hard_mode_details":null,"_moneyIncomplete":false,"_currentProgress":true,"_rawDistance":true,"_rawFuel":true}');
INSERT INTO "logical_projection_states" VALUES(2,'{"id":{"$integer":"2"},"trip_uuid":"70000000-0000-4000-8000-000000000002","plugin_session_ref":{"$integer":"1"},"game":"ets2","game_mode":"single-player","game_mode_method":"module-scan","game_mode_confidence":"weak","game_mode_ambiguous":{"$integer":"0"},"job_configuration_ref":{"$integer":"2"},"truck_configuration_ref":null,"opened_event_ref":{"$integer":"3"},"opened_by":"event","outcome":"none","outcome_event_ref":null,"close_reason":"gap","recording_completeness":"partial","started_utc_ms":{"$integer":"1791676803000"},"ended_utc_ms":{"$integer":"1791676805000"},"observed_distance_m":null,"observed_distance_m_state":"not-observed","created_utc_ms":{"$integer":"1791676803000"},"updated_utc_ms":{"$integer":"1791676805000"},"fuel_used_l":null,"fuel_used_l_state":"not-observed","closed_by_session_ref":{"$integer":"1"},"closed_by_event_seq":"00000000000000000004","is_hard_mode":{"$integer":"0"},"hard_mode_details":null,"_moneyIncomplete":false,"_currentProgress":true,"_rawDistance":false,"_rawFuel":false}');
INSERT INTO "logical_projection_states" VALUES(3,'{"id":{"$integer":"3"},"trip_uuid":"70000000-0000-4000-8000-000000000003","plugin_session_ref":{"$integer":"1"},"game":"ets2","game_mode":"single-player","game_mode_method":"module-scan","game_mode_confidence":"weak","game_mode_ambiguous":{"$integer":"0"},"job_configuration_ref":{"$integer":"3"},"truck_configuration_ref":null,"opened_event_ref":{"$integer":"4"},"opened_by":"event","outcome":"none","outcome_event_ref":null,"close_reason":"restart","recording_completeness":"partial","started_utc_ms":{"$integer":"1791676806000"},"ended_utc_ms":{"$integer":"1791676807000"},"observed_distance_m":0,"observed_distance_m_state":"available","created_utc_ms":{"$integer":"1791676806000"},"updated_utc_ms":{"$integer":"1791676811000"},"fuel_used_l":0,"fuel_used_l_state":"available","closed_by_session_ref":{"$integer":"2"},"closed_by_event_seq":"00000000000000000001","is_hard_mode":{"$integer":"0"},"hard_mode_details":null,"_moneyIncomplete":false,"_currentProgress":true,"_rawDistance":true,"_rawFuel":true}');
INSERT INTO "logical_projection_states" VALUES(4,'{"id":{"$integer":"4"},"trip_uuid":"70000000-0000-4000-8000-000000000004","plugin_session_ref":{"$integer":"2"},"game":"ets2","game_mode":"unknown","game_mode_method":"none","game_mode_confidence":"none","game_mode_ambiguous":{"$integer":"0"},"job_configuration_ref":{"$integer":"4"},"truck_configuration_ref":null,"opened_event_ref":{"$integer":"5"},"opened_by":"event","outcome":"open","outcome_event_ref":null,"close_reason":null,"recording_completeness":"partial","started_utc_ms":{"$integer":"1791676810000"},"ended_utc_ms":null,"observed_distance_m":null,"observed_distance_m_state":"not-observed","created_utc_ms":{"$integer":"1791676811000"},"updated_utc_ms":{"$integer":"1791676811000"},"fuel_used_l":null,"fuel_used_l_state":"not-supported","closed_by_session_ref":null,"closed_by_event_seq":null,"is_hard_mode":{"$integer":"0"},"hard_mode_details":null,"_moneyIncomplete":false,"_currentProgress":true,"_rawDistance":false,"_rawFuel":false}');
CREATE TABLE logical_revisions (
    id INTEGER PRIMARY KEY, logical_ref INTEGER NOT NULL REFERENCES logical_trips(id),
    state_ref INTEGER NOT NULL REFERENCES logical_projection_states(id), member_through INTEGER NOT NULL,
    event_through INTEGER NOT NULL, gap_through INTEGER NOT NULL, sample_through INTEGER NOT NULL, interval_through INTEGER NOT NULL,
    progress_head INTEGER REFERENCES logical_progress(id)) STRICT;
INSERT INTO "logical_revisions" VALUES(1,1,1,1,5,1,2,2,NULL);
INSERT INTO "logical_revisions" VALUES(2,2,2,2,5,1,2,2,NULL);
INSERT INTO "logical_revisions" VALUES(3,3,3,3,5,1,2,2,NULL);
INSERT INTO "logical_revisions" VALUES(4,4,4,4,5,1,2,2,NULL);
INSERT INTO "logical_revisions" VALUES(5,2,2,2,5,1,2,3,NULL);
INSERT INTO "logical_revisions" VALUES(6,2,2,2,5,1,2,4,NULL);
INSERT INTO "logical_revisions" VALUES(7,2,2,2,5,1,2,5,NULL);
INSERT INTO "logical_revisions" VALUES(8,2,2,2,5,1,2,6,NULL);
INSERT INTO "logical_revisions" VALUES(9,2,2,2,5,1,2,7,NULL);
INSERT INTO "logical_revisions" VALUES(10,2,2,2,5,1,2,8,NULL);
INSERT INTO "logical_revisions" VALUES(11,2,2,2,5,1,2,9,NULL);
INSERT INTO "logical_revisions" VALUES(12,2,2,2,5,1,2,10,NULL);
INSERT INTO "logical_revisions" VALUES(13,2,2,2,5,1,2,11,NULL);
INSERT INTO "logical_revisions" VALUES(14,2,2,2,5,1,2,12,NULL);
INSERT INTO "logical_revisions" VALUES(15,2,2,2,5,1,2,13,NULL);
INSERT INTO "logical_revisions" VALUES(16,2,2,2,5,1,2,14,NULL);
INSERT INTO "logical_revisions" VALUES(17,2,2,2,5,1,2,15,NULL);
INSERT INTO "logical_revisions" VALUES(18,2,2,2,5,1,2,16,NULL);
INSERT INTO "logical_revisions" VALUES(19,2,2,2,5,1,2,17,NULL);
INSERT INTO "logical_revisions" VALUES(20,2,2,2,5,1,2,18,NULL);
INSERT INTO "logical_revisions" VALUES(21,2,2,2,5,1,2,19,NULL);
INSERT INTO "logical_revisions" VALUES(22,2,2,2,5,1,2,20,NULL);
INSERT INTO "logical_revisions" VALUES(23,2,2,2,5,1,2,21,NULL);
INSERT INTO "logical_revisions" VALUES(24,2,2,2,5,1,2,22,NULL);
INSERT INTO "logical_revisions" VALUES(25,2,2,2,5,1,2,23,NULL);
INSERT INTO "logical_revisions" VALUES(26,2,2,2,5,1,2,24,NULL);
INSERT INTO "logical_revisions" VALUES(27,2,2,2,5,1,2,25,NULL);
INSERT INTO "logical_revisions" VALUES(28,2,2,2,5,1,2,26,NULL);
INSERT INTO "logical_revisions" VALUES(29,2,2,2,5,1,2,27,NULL);
INSERT INTO "logical_revisions" VALUES(30,2,2,2,5,1,2,28,NULL);
INSERT INTO "logical_revisions" VALUES(31,2,2,2,5,1,2,29,NULL);
INSERT INTO "logical_revisions" VALUES(32,2,2,2,5,1,2,30,NULL);
INSERT INTO "logical_revisions" VALUES(33,2,2,2,5,1,2,31,NULL);
INSERT INTO "logical_revisions" VALUES(34,2,2,2,5,1,2,32,NULL);
INSERT INTO "logical_revisions" VALUES(35,2,2,2,5,1,2,33,NULL);
INSERT INTO "logical_revisions" VALUES(36,2,2,2,5,1,2,34,NULL);
INSERT INTO "logical_revisions" VALUES(37,2,2,2,5,1,2,35,NULL);
INSERT INTO "logical_revisions" VALUES(38,2,2,2,5,1,2,36,NULL);
INSERT INTO "logical_revisions" VALUES(39,2,2,2,5,1,2,37,NULL);
INSERT INTO "logical_revisions" VALUES(40,2,2,2,5,1,2,38,NULL);
INSERT INTO "logical_revisions" VALUES(41,2,2,2,5,1,2,39,NULL);
INSERT INTO "logical_revisions" VALUES(42,2,2,2,5,1,2,40,NULL);
INSERT INTO "logical_revisions" VALUES(43,2,2,2,5,1,2,41,NULL);
INSERT INTO "logical_revisions" VALUES(44,2,2,2,5,1,2,42,NULL);
INSERT INTO "logical_revisions" VALUES(45,2,2,2,5,1,2,43,NULL);
INSERT INTO "logical_revisions" VALUES(46,2,2,2,5,1,2,44,NULL);
INSERT INTO "logical_revisions" VALUES(47,2,2,2,5,1,2,45,NULL);
INSERT INTO "logical_revisions" VALUES(48,2,2,2,5,1,2,46,NULL);
INSERT INTO "logical_revisions" VALUES(49,2,2,2,5,1,2,47,NULL);
INSERT INTO "logical_revisions" VALUES(50,2,2,2,5,1,2,48,NULL);
INSERT INTO "logical_revisions" VALUES(51,2,2,2,5,1,2,49,NULL);
INSERT INTO "logical_revisions" VALUES(52,2,2,2,5,1,2,50,NULL);
INSERT INTO "logical_revisions" VALUES(53,2,2,2,5,1,2,51,NULL);
INSERT INTO "logical_revisions" VALUES(54,2,2,2,5,1,2,52,NULL);
INSERT INTO "logical_revisions" VALUES(55,2,2,2,5,1,2,53,NULL);
INSERT INTO "logical_revisions" VALUES(56,2,2,2,5,1,2,54,NULL);
INSERT INTO "logical_revisions" VALUES(57,2,2,2,5,1,2,55,NULL);
INSERT INTO "logical_revisions" VALUES(58,2,2,2,5,1,2,56,NULL);
INSERT INTO "logical_revisions" VALUES(59,2,2,2,5,1,2,57,NULL);
INSERT INTO "logical_revisions" VALUES(60,2,2,2,5,1,2,58,NULL);
INSERT INTO "logical_revisions" VALUES(61,2,2,2,5,1,2,59,NULL);
INSERT INTO "logical_revisions" VALUES(62,2,2,2,5,1,2,60,NULL);
INSERT INTO "logical_revisions" VALUES(63,2,2,2,5,1,2,61,NULL);
INSERT INTO "logical_revisions" VALUES(64,2,2,2,5,1,2,62,NULL);
INSERT INTO "logical_revisions" VALUES(65,2,2,2,5,1,2,63,NULL);
INSERT INTO "logical_revisions" VALUES(66,2,2,2,5,1,2,64,NULL);
INSERT INTO "logical_revisions" VALUES(67,2,2,2,5,1,2,65,NULL);
INSERT INTO "logical_revisions" VALUES(68,2,2,2,5,1,2,66,NULL);
INSERT INTO "logical_revisions" VALUES(69,2,2,2,5,1,2,67,NULL);
INSERT INTO "logical_revisions" VALUES(70,2,2,2,5,1,2,68,NULL);
INSERT INTO "logical_revisions" VALUES(71,2,2,2,5,1,2,69,NULL);
INSERT INTO "logical_revisions" VALUES(72,2,2,2,5,1,2,70,NULL);
INSERT INTO "logical_revisions" VALUES(73,2,2,2,5,1,2,71,NULL);
INSERT INTO "logical_revisions" VALUES(74,2,2,2,5,1,2,72,NULL);
INSERT INTO "logical_revisions" VALUES(75,2,2,2,5,1,2,73,NULL);
INSERT INTO "logical_revisions" VALUES(76,2,2,2,5,1,2,74,NULL);
INSERT INTO "logical_revisions" VALUES(77,2,2,2,5,1,2,75,NULL);
INSERT INTO "logical_revisions" VALUES(78,2,2,2,5,1,2,76,NULL);
INSERT INTO "logical_revisions" VALUES(79,2,2,2,5,1,2,77,NULL);
INSERT INTO "logical_revisions" VALUES(80,2,2,2,5,1,2,78,NULL);
INSERT INTO "logical_revisions" VALUES(81,2,2,2,5,1,2,79,NULL);
INSERT INTO "logical_revisions" VALUES(82,2,2,2,5,1,2,80,NULL);
INSERT INTO "logical_revisions" VALUES(83,2,2,2,5,1,2,81,NULL);
INSERT INTO "logical_revisions" VALUES(84,2,2,2,5,1,2,82,NULL);
INSERT INTO "logical_revisions" VALUES(85,2,2,2,5,1,2,83,NULL);
INSERT INTO "logical_revisions" VALUES(86,2,2,2,5,1,2,84,NULL);
INSERT INTO "logical_revisions" VALUES(87,2,2,2,5,1,2,85,NULL);
INSERT INTO "logical_revisions" VALUES(88,2,2,2,5,1,2,86,NULL);
INSERT INTO "logical_revisions" VALUES(89,2,2,2,5,1,2,87,NULL);
INSERT INTO "logical_revisions" VALUES(90,2,2,2,5,1,2,88,NULL);
INSERT INTO "logical_revisions" VALUES(91,2,2,2,5,1,2,89,NULL);
INSERT INTO "logical_revisions" VALUES(92,2,2,2,5,1,2,90,NULL);
INSERT INTO "logical_revisions" VALUES(93,2,2,2,5,1,2,91,NULL);
INSERT INTO "logical_revisions" VALUES(94,2,2,2,5,1,2,92,NULL);
INSERT INTO "logical_revisions" VALUES(95,2,2,2,5,1,2,93,NULL);
INSERT INTO "logical_revisions" VALUES(96,2,2,2,5,1,2,94,NULL);
INSERT INTO "logical_revisions" VALUES(97,2,2,2,5,1,2,95,NULL);
INSERT INTO "logical_revisions" VALUES(98,2,2,2,5,1,2,96,NULL);
INSERT INTO "logical_revisions" VALUES(99,2,2,2,5,1,2,97,NULL);
INSERT INTO "logical_revisions" VALUES(100,2,2,2,5,1,2,98,NULL);
INSERT INTO "logical_revisions" VALUES(101,2,2,2,5,1,2,99,NULL);
INSERT INTO "logical_revisions" VALUES(102,2,2,2,5,1,2,100,NULL);
INSERT INTO "logical_revisions" VALUES(103,2,2,2,5,1,2,101,NULL);
INSERT INTO "logical_revisions" VALUES(104,2,2,2,5,1,2,102,NULL);
INSERT INTO "logical_revisions" VALUES(105,2,2,2,5,1,2,103,NULL);
INSERT INTO "logical_revisions" VALUES(106,2,2,2,5,1,2,104,NULL);
INSERT INTO "logical_revisions" VALUES(107,2,2,2,5,1,2,105,NULL);
INSERT INTO "logical_revisions" VALUES(108,2,2,2,5,1,2,106,NULL);
INSERT INTO "logical_revisions" VALUES(109,2,2,2,5,1,2,107,NULL);
INSERT INTO "logical_revisions" VALUES(110,2,2,2,5,1,2,108,NULL);
INSERT INTO "logical_revisions" VALUES(111,2,2,2,5,1,2,109,NULL);
INSERT INTO "logical_revisions" VALUES(112,2,2,2,5,1,2,110,NULL);
INSERT INTO "logical_revisions" VALUES(113,2,2,2,5,1,2,111,NULL);
INSERT INTO "logical_revisions" VALUES(114,2,2,2,5,1,2,112,NULL);
INSERT INTO "logical_revisions" VALUES(115,2,2,2,5,1,2,113,NULL);
INSERT INTO "logical_revisions" VALUES(116,2,2,2,5,1,2,114,NULL);
INSERT INTO "logical_revisions" VALUES(117,2,2,2,5,1,2,115,NULL);
INSERT INTO "logical_revisions" VALUES(118,2,2,2,5,1,2,116,NULL);
INSERT INTO "logical_revisions" VALUES(119,2,2,2,5,1,2,117,NULL);
INSERT INTO "logical_revisions" VALUES(120,2,2,2,5,1,2,118,NULL);
INSERT INTO "logical_revisions" VALUES(121,2,2,2,5,1,2,119,NULL);
INSERT INTO "logical_revisions" VALUES(122,2,2,2,5,1,2,120,NULL);
INSERT INTO "logical_revisions" VALUES(123,2,2,2,5,1,2,121,NULL);
INSERT INTO "logical_revisions" VALUES(124,2,2,2,5,1,2,122,NULL);
CREATE TABLE upload_projection_evidence_versions(root_ref INTEGER PRIMARY KEY REFERENCES logical_trips(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL CHECK(generation>=0)) STRICT;
INSERT INTO "upload_projection_evidence_versions" VALUES(2,120);
CREATE TABLE upload_projection_pins(
    pin_id TEXT PRIMARY KEY, incarnation_uuid TEXT NOT NULL CHECK(length(incarnation_uuid)=36), requested_trip_uuid TEXT NOT NULL REFERENCES trips(trip_uuid),
    root_ref INTEGER NOT NULL REFERENCES logical_trips(id), revision_ref INTEGER NOT NULL REFERENCES logical_revisions(id),
    evidence_generation INTEGER NOT NULL CHECK(evidence_generation>=0),
    state TEXT NOT NULL CHECK(state IN ('preparing','ready','invalidated','releasing')),
    phase TEXT NOT NULL CHECK(phase IN ('current','previous','configurations','intervals','finalize')),
    snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json)),
    member_after INTEGER NOT NULL DEFAULT 0 CHECK(member_after>=0), item_after INTEGER NOT NULL DEFAULT 0 CHECK(item_after>=0),
    source_after INTEGER NOT NULL DEFAULT 0 CHECK(source_after>=0),
    member_count INTEGER NOT NULL DEFAULT 0 CHECK(member_count>=0), configuration_count INTEGER NOT NULL DEFAULT 0 CHECK(configuration_count>=0),
    interval_count INTEGER NOT NULL DEFAULT 0 CHECK(interval_count>=0),
    outcome_trip_ref INTEGER REFERENCES trips(id), close_trip_ref INTEGER REFERENCES trips(id),
    examined INTEGER NOT NULL DEFAULT 0 CHECK(examined BETWEEN 0 AND 100),
    CHECK((state='ready')=(metadata_json IS NOT NULL))) STRICT;
INSERT INTO "upload_projection_pins" VALUES('80000000-0000-4000-8000-000000000001','f03410f6-ca59-494f-93fd-41224bd383ff','70000000-0000-4000-8000-000000000001',1,1,0,'ready','finalize','{"snap":{"revision":{"$integer":"1"},"logical":{"$integer":"1"},"row":{"id":{"$integer":"1"},"trip_uuid":"70000000-0000-4000-8000-000000000001","plugin_session_ref":{"$integer":"1"},"game":"ets2","game_mode":"single-player","game_mode_method":"module-scan","game_mode_confidence":"weak","game_mode_ambiguous":{"$integer":"0"},"job_configuration_ref":{"$integer":"1"},"truck_configuration_ref":null,"opened_event_ref":{"$integer":"1"},"opened_by":"event","outcome":"delivered","outcome_event_ref":{"$integer":"2"},"close_reason":"outcome","recording_completeness":"complete","started_utc_ms":{"$integer":"1791676800000"},"ended_utc_ms":{"$integer":"1791676802000"},"observed_distance_m":151000.25,"observed_distance_m_state":"available","created_utc_ms":{"$integer":"1791676801000"},"updated_utc_ms":{"$integer":"1791676802000"},"fuel_used_l":42.5,"fuel_used_l_state":"available","closed_by_session_ref":{"$integer":"1"},"closed_by_event_seq":"00000000000000000002","is_hard_mode":{"$integer":"0"},"hard_mode_details":null,"_moneyIncomplete":false,"_currentProgress":true,"_rawDistance":true,"_rawFuel":true},"members":{"$integer":"1"},"events":{"$integer":"5"},"gaps":{"$integer":"1"},"samples":{"$integer":"2"},"intervals":{"$integer":"2"},"head":null},"initial":{"requestedTripUuid":"70000000-0000-4000-8000-000000000001","rootTripUuid":"70000000-0000-4000-8000-000000000001","readiness":"ready","rootReadiness":"ready","snapshot":"u2:f0000000-0000-4000-8000-000000000002:80000000-0000-4000-8000-000000000001:f03410f6-ca59-494f-93fd-41224bd383ff:70000000-0000-4000-8000-000000000001:1","databaseUuid":"f0000000-0000-4000-8000-000000000002","purpose":"synthetic","revision":"1","bounds":{"members":"1","events":"5","gaps":"1","samples":"2","intervals":"2","accountingHead":null}}}','{"requestedTripUuid":"70000000-0000-4000-8000-000000000001","rootTripUuid":"70000000-0000-4000-8000-000000000001","readiness":"ready","rootReadiness":"ready","snapshot":"u2:f0000000-0000-4000-8000-000000000002:80000000-0000-4000-8000-000000000001:f03410f6-ca59-494f-93fd-41224bd383ff:70000000-0000-4000-8000-000000000001:1","databaseUuid":"f0000000-0000-4000-8000-000000000002","purpose":"synthetic","revision":"1","bounds":{"members":"1","events":"5","gaps":"1","samples":"2","intervals":"2","accountingHead":null},"totals":{"members":1,"configurations":0,"intervals":0},"facts":{"game":"ets2","pluginSessionId":"10000000-0000-4000-8000-000000000001","outcome":"delivered","closeReason":"outcome","recordingCompleteness":"complete","openedBy":"event","checkpointNextEventSeq":null,"checkpointUtcMs":null,"opening":{"pluginSessionId":"10000000-0000-4000-8000-000000000001","rawTripUuid":"70000000-0000-4000-8000-000000000001","eventSeq":"1","type":"job.configured","utcMs":1791676800000},"outcomeOccurrence":{"pluginSessionId":"10000000-0000-4000-8000-000000000001","rawTripUuid":"70000000-0000-4000-8000-000000000001","eventSeq":"2","type":"job.delivered","utcMs":1791676800000},"close":{"pluginSessionId":"10000000-0000-4000-8000-000000000001","rawTripUuid":"70000000-0000-4000-8000-000000000001","eventSeq":"2","type":"job.delivered","utcMs":1791676800000},"gameMode":{"mode":"single-player","method":"module-scan","confidence":"weak","ambiguous":false},"job":{"sourceCityId":{"available":true,"value":"synthetic_city_a"},"sourceCity":{"available":true,"value":"Synthetic City A"},"sourceCompanyId":{"available":true,"value":"synthetic_company_a"},"sourceCompany":{"available":true,"value":"Synthetic Company A"},"destinationCityId":{"available":true,"value":"synthetic_city_b"},"destinationCity":{"available":true,"value":"Synthetic City B"},"destinationCompanyId":{"available":true,"value":"synthetic_company_b"},"destinationCompany":{"available":true,"value":"Synthetic Company B"},"cargoId":{"available":true,"value":"synthetic_cargo"},"cargo":{"available":true,"value":"Synthetic Cargo"},"cargoMass":{"available":true,"value":18000,"unit":"kg"},"cargoUnitMass":{"available":true,"value":1000,"unit":"kg"},"cargoUnitCount":{"available":true,"value":18},"market":{"available":true,"value":"freight_market"},"isSpecialJob":{"available":true,"value":false},"cargoLoaded":{"available":true,"value":true},"plannedDistance":{"available":true,"value":152000,"unit":"m"},"expectedIncome":{"available":true,"value":{"raw":"12345","sdkType":"u64","currency":{"status":"unknown"}}},"deliveryDeadline":{"available":true,"value":"13000","unit":"min"}},"observedDistance":{"available":true,"value":151000.25,"unit":"m"},"fuelUsed":{"available":true,"value":42.5,"unit":"L"},"deliveredDistance":{"available":true,"unit":"m","value":151250.5},"cargoDamage":{"available":true,"unit":"fraction","value":0.0125},"revenue":{"available":true,"value":{"currency":{"status":"unknown"},"raw":"15000","sdkType":"s64"}},"penalty":{"available":false,"reason":"not-observed"},"moneyIncomplete":false,"clockAnomaly":true}}',0,0,0,1,0,0,1,1,10);
INSERT INTO "upload_projection_pins" VALUES('80000000-0000-4000-8000-000000000002','fb42ea9f-c046-4e36-aedc-7ea5434f32dd','70000000-0000-4000-8000-000000000002',2,124,120,'preparing','intervals','{"snap":{"revision":{"$integer":"124"},"logical":{"$integer":"2"},"row":{"id":{"$integer":"2"},"trip_uuid":"70000000-0000-4000-8000-000000000002","plugin_session_ref":{"$integer":"1"},"game":"ets2","game_mode":"single-player","game_mode_method":"module-scan","game_mode_confidence":"weak","game_mode_ambiguous":{"$integer":"0"},"job_configuration_ref":{"$integer":"2"},"truck_configuration_ref":null,"opened_event_ref":{"$integer":"3"},"opened_by":"event","outcome":"none","outcome_event_ref":null,"close_reason":"gap","recording_completeness":"partial","started_utc_ms":{"$integer":"1791676803000"},"ended_utc_ms":{"$integer":"1791676805000"},"observed_distance_m":null,"observed_distance_m_state":"not-observed","created_utc_ms":{"$integer":"1791676803000"},"updated_utc_ms":{"$integer":"1791676805000"},"fuel_used_l":null,"fuel_used_l_state":"not-observed","closed_by_session_ref":{"$integer":"1"},"closed_by_event_seq":"00000000000000000004","is_hard_mode":{"$integer":"0"},"hard_mode_details":null,"_moneyIncomplete":false,"_currentProgress":true,"_rawDistance":false,"_rawFuel":false},"members":{"$integer":"2"},"events":{"$integer":"5"},"gaps":{"$integer":"1"},"samples":{"$integer":"2"},"intervals":{"$integer":"122"},"head":null},"initial":{"requestedTripUuid":"70000000-0000-4000-8000-000000000002","rootTripUuid":"70000000-0000-4000-8000-000000000002","readiness":"ready","rootReadiness":"ready","snapshot":"u2:f0000000-0000-4000-8000-000000000002:80000000-0000-4000-8000-000000000002:fb42ea9f-c046-4e36-aedc-7ea5434f32dd:70000000-0000-4000-8000-000000000002:124","databaseUuid":"f0000000-0000-4000-8000-000000000002","purpose":"synthetic","revision":"124","bounds":{"members":"2","events":"5","gaps":"1","samples":"2","intervals":"122","accountingHead":null}}}',NULL,0,94,2,1,0,93,NULL,2,100);
CREATE TABLE upload_projection_members(pin_ref TEXT NOT NULL REFERENCES upload_projection_pins(pin_id), trip_ref INTEGER NOT NULL REFERENCES trips(id),
    row_json TEXT NOT NULL CHECK(json_valid(row_json)), PRIMARY KEY(pin_ref,trip_ref)) STRICT;
INSERT INTO "upload_projection_members" VALUES('80000000-0000-4000-8000-000000000001',1,'{"id":"1","rawTripUuid":"70000000-0000-4000-8000-000000000001","pluginSessionId":"10000000-0000-4000-8000-000000000001","game":"ets2","origin":"synthetic","versions":{"nativeProtocol":{"major":1,"minor":0},"sdkArchive":{"available":true,"value":"scs-sdk-1.15"},"telemetryApi":{"available":true,"value":{"major":1,"minor":1}},"gameTelemetryApi":{"available":true,"value":{"major":1,"minor":19}}}}');
INSERT INTO "upload_projection_members" VALUES('80000000-0000-4000-8000-000000000002',2,'{"id":"2","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001","game":"ets2","origin":"synthetic","versions":{"nativeProtocol":{"major":1,"minor":0},"sdkArchive":{"available":true,"value":"scs-sdk-1.15"},"telemetryApi":{"available":true,"value":{"major":1,"minor":1}},"gameTelemetryApi":{"available":true,"value":{"major":1,"minor":19}}}}');
CREATE TABLE upload_projection_configurations(pin_ref TEXT NOT NULL REFERENCES upload_projection_pins(pin_id), event_ref INTEGER NOT NULL REFERENCES events(id),
    qualified INTEGER NOT NULL CHECK(qualified IN (0,1)), raw_trip_uuid TEXT NOT NULL,
    row_json TEXT NOT NULL CHECK(json_valid(row_json)), PRIMARY KEY(pin_ref,event_ref)) STRICT;
CREATE TABLE upload_projection_intervals(pin_ref TEXT NOT NULL REFERENCES upload_projection_pins(pin_id), interval_ref INTEGER NOT NULL REFERENCES completeness_intervals(id),
    row_json TEXT NOT NULL CHECK(json_valid(row_json)), PRIMARY KEY(pin_ref,interval_ref)) STRICT;
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',1,'{"id":"1","kind":"event-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',3,'{"id":"3","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',4,'{"id":"4","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',5,'{"id":"5","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',6,'{"id":"6","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',7,'{"id":"7","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',8,'{"id":"8","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',9,'{"id":"9","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',10,'{"id":"10","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',11,'{"id":"11","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',12,'{"id":"12","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',13,'{"id":"13","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',14,'{"id":"14","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',15,'{"id":"15","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',16,'{"id":"16","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',17,'{"id":"17","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',18,'{"id":"18","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',19,'{"id":"19","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',20,'{"id":"20","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',21,'{"id":"21","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',22,'{"id":"22","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',23,'{"id":"23","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',24,'{"id":"24","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',25,'{"id":"25","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',26,'{"id":"26","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',27,'{"id":"27","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',28,'{"id":"28","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',29,'{"id":"29","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',30,'{"id":"30","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',31,'{"id":"31","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',32,'{"id":"32","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',33,'{"id":"33","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',34,'{"id":"34","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',35,'{"id":"35","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',36,'{"id":"36","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',37,'{"id":"37","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',38,'{"id":"38","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',39,'{"id":"39","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',40,'{"id":"40","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',41,'{"id":"41","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',42,'{"id":"42","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',43,'{"id":"43","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',44,'{"id":"44","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',45,'{"id":"45","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',46,'{"id":"46","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',47,'{"id":"47","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',48,'{"id":"48","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',49,'{"id":"49","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',50,'{"id":"50","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',51,'{"id":"51","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',52,'{"id":"52","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',53,'{"id":"53","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',54,'{"id":"54","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',55,'{"id":"55","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',56,'{"id":"56","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',57,'{"id":"57","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',58,'{"id":"58","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',59,'{"id":"59","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',60,'{"id":"60","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',61,'{"id":"61","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',62,'{"id":"62","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',63,'{"id":"63","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',64,'{"id":"64","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',65,'{"id":"65","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',66,'{"id":"66","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',67,'{"id":"67","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',68,'{"id":"68","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',69,'{"id":"69","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',70,'{"id":"70","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',71,'{"id":"71","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',72,'{"id":"72","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',73,'{"id":"73","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',74,'{"id":"74","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',75,'{"id":"75","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',76,'{"id":"76","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',77,'{"id":"77","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',78,'{"id":"78","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',79,'{"id":"79","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',80,'{"id":"80","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',81,'{"id":"81","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',82,'{"id":"82","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',83,'{"id":"83","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',84,'{"id":"84","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',85,'{"id":"85","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',86,'{"id":"86","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',87,'{"id":"87","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',88,'{"id":"88","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',89,'{"id":"89","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',90,'{"id":"90","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',91,'{"id":"91","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',92,'{"id":"92","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',93,'{"id":"93","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
INSERT INTO "upload_projection_intervals" VALUES('80000000-0000-4000-8000-000000000002',94,'{"id":"94","kind":"sample-loss","rawTripUuid":"70000000-0000-4000-8000-000000000002","pluginSessionId":"10000000-0000-4000-8000-000000000001"}');
CREATE TRIGGER database_info_no_update BEFORE UPDATE ON database_info BEGIN SELECT RAISE(ABORT, 'database_info rows are immutable'); END;
CREATE TRIGGER database_info_no_delete BEFORE DELETE ON database_info BEGIN SELECT RAISE(ABORT, 'database_info rows are immutable'); END;
CREATE TRIGGER plugin_sessions_origin BEFORE INSERT ON plugin_sessions WHEN NEW.origin IS NOT (SELECT accepted_origin FROM database_info WHERE id = 1)
    BEGIN SELECT RAISE(ABORT, 'plugin session origin is not accepted by this database'); END;
CREATE TRIGGER plugin_sessions_identity BEFORE UPDATE OF plugin_session_uuid, game, origin, process_instance_uuid, process_id, windows_session_id ON plugin_sessions
    BEGIN SELECT RAISE(ABORT, 'plugin session identity is immutable'); END;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events rows are immutable'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events rows are immutable'); END;
CREATE TRIGGER event_gaps_no_update BEFORE UPDATE ON event_gaps BEGIN SELECT RAISE(ABORT, 'event_gaps rows are immutable'); END;
CREATE TRIGGER event_gaps_no_delete BEFORE DELETE ON event_gaps BEGIN SELECT RAISE(ABORT, 'event_gaps rows are immutable'); END;
CREATE INDEX samples_session ON samples (plugin_session_ref, id);
CREATE INDEX samples_trip ON samples (trip_ref, id) WHERE trip_ref IS NOT NULL;
CREATE INDEX event_attributions_trip ON event_attributions (trip_ref);
CREATE INDEX completeness_intervals_trip ON completeness_intervals (trip_ref);
CREATE INDEX completeness_intervals_session ON completeness_intervals (plugin_session_ref);
CREATE VIEW logical_snapshot_memberships AS SELECT trip_ref,logical_ref,coalesce(joined_after_revision,0) AS from_revision,NULL AS through_revision FROM logical_memberships
    UNION ALL SELECT trip_ref,previous_logical_ref,0,joined_after_revision FROM logical_memberships WHERE previous_logical_ref IS NOT NULL;
CREATE INDEX logical_memberships_previous ON logical_memberships(previous_logical_ref,trip_ref);
CREATE INDEX logical_memberships_group ON logical_memberships(logical_ref, trip_ref);
CREATE INDEX logical_profile_slots ON logical_trips(game,profile_scope,retired,id);
CREATE INDEX logical_candidates ON logical_trips(game, profile_scope, fingerprint, retired);
CREATE INDEX logical_progress_cut ON logical_progress(logical_ref, truck_ref, start_odometer_m, odometer_m);
CREATE INDEX logical_revisions_group ON logical_revisions(logical_ref, id);
CREATE INDEX upload_projection_retained_root ON upload_projection_pins(root_ref);
CREATE TRIGGER upload_projection_trailer_insert AFTER INSERT ON trip_trailers BEGIN
    INSERT INTO upload_projection_evidence_versions(root_ref,generation)
  SELECT root,1 FROM (SELECT logical_ref AS root FROM logical_memberships WHERE trip_ref=NEW.trip_ref
  UNION SELECT previous_logical_ref FROM logical_memberships WHERE trip_ref=NEW.trip_ref) WHERE root IS NOT NULL
  ON CONFLICT(root_ref) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER upload_projection_trailer_delete AFTER DELETE ON trip_trailers BEGIN
    INSERT INTO upload_projection_evidence_versions(root_ref,generation)
  SELECT root,1 FROM (SELECT logical_ref AS root FROM logical_memberships WHERE trip_ref=OLD.trip_ref
  UNION SELECT previous_logical_ref FROM logical_memberships WHERE trip_ref=OLD.trip_ref) WHERE root IS NOT NULL
  ON CONFLICT(root_ref) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER upload_projection_trailer_update AFTER UPDATE ON trip_trailers BEGIN
    INSERT INTO upload_projection_evidence_versions(root_ref,generation)
  SELECT root,1 FROM (SELECT logical_ref AS root FROM logical_memberships WHERE trip_ref=OLD.trip_ref
  UNION SELECT previous_logical_ref FROM logical_memberships WHERE trip_ref=OLD.trip_ref UNION SELECT logical_ref AS root FROM logical_memberships WHERE trip_ref=NEW.trip_ref
  UNION SELECT previous_logical_ref FROM logical_memberships WHERE trip_ref=NEW.trip_ref) WHERE root IS NOT NULL
  ON CONFLICT(root_ref) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER upload_projection_interval_insert AFTER INSERT ON completeness_intervals BEGIN
    INSERT INTO upload_projection_evidence_versions(root_ref,generation)
  SELECT root,1 FROM (SELECT logical_ref AS root FROM logical_memberships WHERE trip_ref=NEW.trip_ref
  UNION SELECT previous_logical_ref FROM logical_memberships WHERE trip_ref=NEW.trip_ref) WHERE root IS NOT NULL
  ON CONFLICT(root_ref) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER upload_projection_interval_delete AFTER DELETE ON completeness_intervals BEGIN
    INSERT INTO upload_projection_evidence_versions(root_ref,generation)
  SELECT root,1 FROM (SELECT logical_ref AS root FROM logical_memberships WHERE trip_ref=OLD.trip_ref
  UNION SELECT previous_logical_ref FROM logical_memberships WHERE trip_ref=OLD.trip_ref) WHERE root IS NOT NULL
  ON CONFLICT(root_ref) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER upload_projection_interval_update AFTER UPDATE ON completeness_intervals BEGIN
    INSERT INTO upload_projection_evidence_versions(root_ref,generation)
  SELECT root,1 FROM (SELECT logical_ref AS root FROM logical_memberships WHERE trip_ref=OLD.trip_ref
  UNION SELECT previous_logical_ref FROM logical_memberships WHERE trip_ref=OLD.trip_ref UNION SELECT logical_ref AS root FROM logical_memberships WHERE trip_ref=NEW.trip_ref
  UNION SELECT previous_logical_ref FROM logical_memberships WHERE trip_ref=NEW.trip_ref) WHERE root IS NOT NULL
  ON CONFLICT(root_ref) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER upload_projection_membership_insert AFTER INSERT ON logical_memberships BEGIN
    INSERT INTO upload_projection_evidence_versions(root_ref,generation)
  SELECT root,1 FROM (SELECT NEW.logical_ref AS root UNION SELECT NEW.previous_logical_ref) WHERE root IS NOT NULL
  ON CONFLICT(root_ref) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER upload_projection_membership_delete AFTER DELETE ON logical_memberships BEGIN
    INSERT INTO upload_projection_evidence_versions(root_ref,generation)
  SELECT root,1 FROM (SELECT OLD.logical_ref AS root UNION SELECT OLD.previous_logical_ref) WHERE root IS NOT NULL
  ON CONFLICT(root_ref) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER upload_projection_membership_update AFTER UPDATE OF logical_ref,previous_logical_ref,joined_after_revision ON logical_memberships BEGIN
    INSERT INTO upload_projection_evidence_versions(root_ref,generation)
  SELECT root,1 FROM (SELECT OLD.logical_ref AS root UNION SELECT OLD.previous_logical_ref UNION SELECT NEW.logical_ref AS root UNION SELECT NEW.previous_logical_ref) WHERE root IS NOT NULL
  ON CONFLICT(root_ref) DO UPDATE SET generation=generation+1; END;
