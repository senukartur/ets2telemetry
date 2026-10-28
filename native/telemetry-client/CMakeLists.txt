cmake_minimum_required(VERSION 4.3)
project(ETS2TelemetryPipeClient LANGUAGES CXX)
if(NOT WIN32 OR NOT MSVC OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "The telemetry pipe client requires Windows x64 and MSVC.")
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
include(CTest)
# Build channel (ET-055 UP12): selects the pipe prefix in ../telemetry-plugin/src/channel-identity.hpp that the broker
# accepts and connects to. The default keeps the production prefix; configure the plugin tree with the same value.
set(ETS2TELEMETRY_CHANNEL "production" CACHE STRING "Build channel of the native identities: production or staging")
set_property(CACHE ETS2TELEMETRY_CHANNEL PROPERTY STRINGS production staging)
if(NOT ETS2TELEMETRY_CHANNEL STREQUAL "production" AND NOT ETS2TELEMETRY_CHANNEL STREQUAL "staging")
  message(FATAL_ERROR "ETS2TELEMETRY_CHANNEL must be production or staging, not '${ETS2TELEMETRY_CHANNEL}'")
endif()
string(TOUPPER "${ETS2TELEMETRY_CHANNEL}" ETS2TELEMETRY_CHANNEL_UPPER)
# One CTest entry per fixture case, so a slow case is named and bounded on its own. Keep this list in
# the fixture's run order; the case-list entry fails if it differs from tests/client-test.cpp.
set(CLIENT_TEST_CASES
  retired-record delete-pending-record denied-record zero-record short-record directory-record reparse-record
  valid creation dead stale-live dead-live collision session malformed dacl payload-break bad-length invalid-credit quiet quiet-exit partial-prefix partial-payload
  capture capture-v0-hello capture-bad-arguments
  v1-valid v1-policy v1-major-mismatch v1-name-mismatch v1-collision v1-v0-hello v1-cap0-hello
  v1-client-kind v1-client-oversize v1-bad-tag v1-partial-length v1-partial-payload v1-zero-length v1-ack-while-quiet v1-write-deadline v1-capture-conflict
  v1-minor1-valid v1-minor-above-offer v1-minor-changed v1-minor2-valid v1-minor2-above-offer
  policy-prune policy-cap policy-duplicate policy-case-duplicate policy-junction
  policy-lock-busy policy-lock-pending policy-publish-busy image-busy policy-readonly)
# These cases wait out the broker's fixed 5 s frame or client-write deadline or the fixture's 5.5 s
# quiet window (about 5-6 s each; every other case takes well under 1 s). Per-entry timeouts are hang
# backstops above the fixture's own 15 s wait bound; ASan entries get twice the time.
set(CLIENT_TEST_TIMED_CASES quiet quiet-exit partial-prefix partial-payload v1-write-deadline)
function(add_client_test_cases prefix fixture broker scale)
  foreach(test_case IN LISTS CLIENT_TEST_CASES)
    if(test_case IN_LIST CLIENT_TEST_TIMED_CASES)
      math(EXPR timeout "30 * ${scale}")
    else()
      math(EXPR timeout "20 * ${scale}")
    endif()
    add_test(NAME ${prefix}-${test_case} COMMAND ${fixture} $<TARGET_FILE:${broker}> "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/fixtures/protocol-v0")
    # The fixture's endpoint names are fixed per user and session, so entries never run concurrently.
    set_tests_properties(${prefix}-${test_case} PROPERTIES ENVIRONMENT "ETS2TELEMETRY_CLIENT_TEST_CASE=${test_case}" TIMEOUT ${timeout} RESOURCE_LOCK ets2telemetry-client-fixture-endpoints)
  endforeach()
  string(JOIN "," joined ${CLIENT_TEST_CASES})
  add_test(NAME ${prefix}-case-list COMMAND ${fixture} --verify-cases ${joined})
  set_tests_properties(${prefix}-case-list PROPERTIES TIMEOUT 10)
endfunction()
option(ETS2TELEMETRY_CLIENT_ASAN "Build separate AddressSanitizer console fixtures" OFF)
if(ETS2TELEMETRY_CLIENT_ASAN)
  foreach(target IN ITEMS telemetry-pipe-client-asan telemetry-client-test-asan)
    if(target STREQUAL "telemetry-pipe-client-asan")
      set(entry src/client.cpp)
    else()
      set(entry tests/client-test.cpp)
    endif()
    add_executable(${target} ${entry} ../telemetry-plugin/src/protocol-v0.cpp ../telemetry-plugin/src/protocol-v1.cpp)
    target_include_directories(${target} PRIVATE ../telemetry-plugin/src)
    target_compile_definitions(${target} PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE ETS2TELEMETRY_CLIENT_ASAN_DIAGNOSTICS ETS2TELEMETRY_CHANNEL_${ETS2TELEMETRY_CHANNEL_UPPER})
    target_compile_options(${target} PRIVATE /W4 /WX /EHsc /fsanitize=address /Zi)
    target_link_options(${target} PRIVATE /DEBUG /INCREMENTAL:NO)
    target_link_libraries(${target} PRIVATE advapi32 bcrypt)
  endforeach()
  set_target_properties(telemetry-client-test-asan PROPERTIES OUTPUT_NAME eurotrucks2 RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/asan-test-fixture")
  add_client_test_cases(native-pipe-client-asan telemetry-client-test-asan telemetry-pipe-client-asan 2)
endif()
add_executable(telemetry-pipe-client src/client.cpp ../telemetry-plugin/src/protocol-v0.cpp ../telemetry-plugin/src/protocol-v1.cpp)
target_include_directories(telemetry-pipe-client PRIVATE ../telemetry-plugin/src)
target_compile_definitions(telemetry-pipe-client PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE ETS2TELEMETRY_CHANNEL_${ETS2TELEMETRY_CHANNEL_UPPER})
target_compile_options(telemetry-pipe-client PRIVATE /W4 /WX /EHsc)
target_link_libraries(telemetry-pipe-client PRIVATE advapi32 bcrypt)
if(BUILD_TESTING)
  add_executable(telemetry-client-test tests/client-test.cpp ../telemetry-plugin/src/protocol-v0.cpp ../telemetry-plugin/src/protocol-v1.cpp)
  target_include_directories(telemetry-client-test PRIVATE ../telemetry-plugin/src)
  target_compile_definitions(telemetry-client-test PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE ETS2TELEMETRY_CHANNEL_${ETS2TELEMETRY_CHANNEL_UPPER})
  target_compile_options(telemetry-client-test PRIVATE /W4 /WX /EHsc)
  target_link_libraries(telemetry-client-test PRIVATE advapi32 bcrypt)
  set_target_properties(telemetry-client-test PROPERTIES OUTPUT_NAME eurotrucks2 RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/test-fixture")
  add_client_test_cases(native-pipe-client telemetry-client-test telemetry-pipe-client 1)
endif()
