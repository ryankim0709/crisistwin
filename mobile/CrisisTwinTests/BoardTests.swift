import XCTest
@testable import CrisisTwin

final class BoardTests: XCTestCase {
    private let lat0 = 39.76
    private let lon0 = -121.60
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    /// A point `east` meters east and `north` meters north of the fixture origin.
    private func pt(_ east: Double, _ north: Double = 0) -> LonLat {
        LonLat(lon: lon0 + east / (111_320 * cos(lat0 * .pi / 180)), lat: lat0 + north / 110_540)
    }

    /// A segment running east from `from` to `to` meters.
    private func item(_ id: String, rank: Int = 1, from: Double = 0, to: Double = 800, north: Double = 0,
                      question: BoardQuestionKind = .roadStatus, kind: BoardPlaceKind = .segment,
                      expires: TimeInterval = 1800) -> BoardItem {
        let line = [pt(from, north), pt(to, north)]
        return BoardItem(
            taskId: "tsk_\(id)", rank: rank, question: question,
            place: BoardPlace(kind: kind, segmentId: "seg:\(id)", destinationId: nil, name: "Road \(id)",
                              coord: pt((from + to) / 2, north), line: line, freeFlowKph: 56),
            expiresAt: t0.addingTimeInterval(expires))
    }

    private func fireSquare(centerEast: Double, centerNorth: Double, half: Double = 100) -> LiveGeometry {
        LiveGeometry(polygons: [[[
            pt(centerEast - half, centerNorth - half), pt(centerEast + half, centerNorth - half),
            pt(centerEast + half, centerNorth + half), pt(centerEast - half, centerNorth + half),
            pt(centerEast - half, centerNorth - half)]]])
    }

    // MARK: Decoding

    func testBoardDecodingSkipsUnknownValues() throws {
        let json = """
        {"incident_id":"x","generated_at":"2026-10-24T18:00:00Z",
         "limits":{"radius_m":1200,"max_questions":2,"stall_s":90,"slow_ratio":0.4},
         "items":[
          {"task_id":"a","rank":1,"question":"road_status","expires_at":"2026-10-24T18:35:00Z",
           "place":{"kind":"segment","segment_id":"s","destination_id":null,"name":"Pentz Road",
                    "coord":[-121.6,39.76],"line":[[-121.6,39.76],[-121.59,39.76]],"free_flow_kph":56}},
          {"task_id":"b","rank":2,"question":"bridge_check","expires_at":"2026-10-24T18:35:00Z",
           "place":{"kind":"segment","name":"X","coord":[-121.6,39.76]}},
          {"task_id":"c","rank":3,"question":"shelter_full","expires_at":"2026-10-24T18:35:00Z",
           "place":{"kind":"junction","name":"Y","coord":[-121.6,39.76]}},
          {"task_id":"d","rank":4,"question":"shelter_full","expires_at":"2026-10-24T18:35:00Z",
           "place":{"kind":"destination","destination_id":"dst1","name":"Gym","coord":[-121.61,39.77],
                    "line":null,"free_flow_kph":null}}]}
        """
        let response = try LiveJSON.decoder.decode(BoardResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.items.map(\.taskId), ["a", "d"])
        XCTAssertEqual(response.limits.radiusM, 1200)
        XCTAssertEqual(response.limits.maxQuestions, 2)
        XCTAssertEqual(response.items[0].place.freeFlowKph, 56)
        XCTAssertNil(response.items[1].place.line)
    }

    func testPassiveReportHasNoPositionKeys() throws {
        let draft = ReportDraft.passive(incidentId: "i", kind: .heavyTraffic, segmentId: "seg:1", taskId: "tsk_1",
                                        observedAt: t0, slow: true)
        let data = try LiveJSON.encoder.encode(draft)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        for key in ["location", "heading_deg", "note", "destination_id", "severity"] {
            XCTAssertNil(json[key], key)
        }
        XCTAssertEqual(json["method"] as? String, "passive")
        XCTAssertEqual(json["segment_id"] as? String, "seg:1")
        XCTAssertEqual(json["speed_class"] as? String, "slow")
        XCTAssertEqual(json["task_id"] as? String, "tsk_1")
        XCTAssertEqual(json["kind"] as? String, "heavy_traffic")
    }

    // MARK: Selection

    func testSelectsRouteAndNearbyAndKeepsRankOrder() {
        let route = [pt(-200), pt(1000)]
        let onRoute = item("route", rank: 3, from: 100, to: 700)
        let offRoute = item("off", rank: 1, from: 100, to: 700, north: 3000)
        let nearDevice = item("near", rank: 2, from: 100, to: 700, north: 900)
        let device = pt(400, 900)
        let picked = BoardSelector.select(items: [onRoute, offRoute, nearDevice], route: route, device: device,
                                          fire: nil, now: t0)
        XCTAssertEqual(picked.map(\.taskId), ["tsk_near", "tsk_route"])
    }

    func testRouteNeedsTwoQuarterPointsWithin30m() {
        // Only the first quarter point of this segment is near the route (it leaves the route).
        let route = [pt(0), pt(250)]
        let leaving = item("leaving", from: 0, to: 800)
        XCTAssertFalse(BoardSelector.isOnRoute(leaving, route: route))
        let along = item("along", from: 0, to: 250)
        XCTAssertTrue(BoardSelector.isOnRoute(along, route: route))
    }

    func testRadiusAndMaxQuestions() {
        let items = (1...5).map { item("\($0)", rank: $0, from: 0, to: 100, north: Double($0) * 10) }
        var limits = BoardLimits()
        XCTAssertEqual(BoardSelector.select(items: items, route: nil, device: pt(50), fire: nil, limits: limits,
                                            now: t0).map(\.rank), [1, 2, 3])
        limits.radiusM = 5
        XCTAssertTrue(BoardSelector.select(items: items, route: nil, device: pt(50), fire: nil, limits: limits,
                                           now: t0).isEmpty)
        XCTAssertTrue(BoardSelector.select(items: items, route: nil, device: nil, fire: nil, now: t0).isEmpty)
    }

    func testFireExclusion() {
        let route = [pt(-100), pt(2000)]
        let far = item("far", from: 0, to: 400)
        // The fire square's edge is 600 m from the segment (inside the 1000 m exclusion).
        let fire = fireSquare(centerEast: 200, centerNorth: 700)
        XCTAssertTrue(BoardSelector.select(items: [far], route: route, device: pt(0), fire: fire, now: t0).isEmpty)
        // Far enough away: kept.
        let distant = fireSquare(centerEast: 200, centerNorth: 1500)
        XCTAssertEqual(BoardSelector.select(items: [far], route: route, device: pt(0), fire: distant, now: t0).count, 1)
        // Inside the fire.
        let inside = fireSquare(centerEast: 200, centerNorth: 0, half: 300)
        XCTAssertTrue(BoardSelector.select(items: [far], route: route, device: pt(0), fire: inside, now: t0).isEmpty)
    }

    func testFireNearOnlyOneEndOfSegmentDropsIt() {
        let long = item("long", from: 0, to: 3000)
        let fire = fireSquare(centerEast: 3000, centerNorth: 1050)
        XCTAssertTrue(BoardSelector.nearFire(long, fire: fire))
    }

    func testExpiredItemsDropped() {
        let old = item("old", expires: -1)
        XCTAssertTrue(BoardSelector.select(items: [old], route: nil, device: pt(100), fire: nil, now: t0).isEmpty)
    }

    // MARK: Answers

    func testAnswersAreExplicitReportsAtThePlace() throws {
        let road = BoardQuestion(item: item("r"))
        XCTAssertEqual(road.title, "Road r: passable?")
        XCTAssertEqual(road.answers, [.passable, .slow, .blocked])
        let slow = try XCTUnwrap(road.draft(for: .slow, incidentId: "i", at: t0))
        XCTAssertEqual(slow.kind, .heavyTraffic)
        XCTAssertEqual(slow.severity, .slow)
        XCTAssertEqual(slow.taskId, "tsk_r")
        XCTAssertEqual(slow.location?.coord, road.item.place.coord)
        XCTAssertNil(slow.location?.accuracyM)
        XCTAssertNil(slow.method)
        let blocked = try XCTUnwrap(road.draft(for: .blocked, incidentId: "i", at: t0))
        XCTAssertEqual(blocked.kind, .roadBlocked)
        XCTAssertEqual(blocked.severity, .full)
        XCTAssertEqual(try XCTUnwrap(road.draft(for: .passable, incidentId: "i")).kind, .roadPassable)

        var shelterItem = item("s", question: .shelterFull, kind: .destination)
        shelterItem.place.destinationId = "dst1"
        let shelter = BoardQuestion(item: shelterItem)
        XCTAssertEqual(shelter.title, "Road s: full?")
        XCTAssertEqual(shelter.answers, [.full, .hasSpace])
        let full = try XCTUnwrap(shelter.draft(for: .full, incidentId: "i"))
        XCTAssertEqual(full.kind, .shelterFull)
        XCTAssertEqual(full.destinationId, "dst1")
        XCTAssertNil(shelter.draft(for: .hasSpace, incidentId: "i"))

        let stall = BoardQuestion(item: item("r"), isStall: true)
        XCTAssertEqual(stall.title, "Road ahead blocked?")
        XCTAssertEqual(try XCTUnwrap(stall.draft(for: .yes, incidentId: "i")).kind, .roadBlocked)
        XCTAssertNil(stall.draft(for: .no, incidentId: "i"))
    }

    // MARK: Passive traversal

    /// Fixes every second driving east at `speed` m/s from `start` to `end` meters.
    private func drive(_ machine: inout PassiveTraversal, from start: Double, to end: Double, speed: Double,
                       north: Double = 0, startingAt: TimeInterval = 0) -> [PassiveTraversal.Traversed] {
        var events: [PassiveTraversal.Traversed] = []
        var east = start
        var t = startingAt
        while east <= end {
            events += machine.feed(BoardFix(coord: pt(east, north), at: t0.addingTimeInterval(t), speedMps: speed))
            east += speed
            t += 1
        }
        return events
    }

    private func tracked(from: Double = 0, to: Double = 800) -> BoardTracked {
        BoardTracked(item: item("p", from: from, to: to))!
    }

    func testTraversalAtDrivingSpeed() {
        var machine = PassiveTraversal()
        machine.track([tracked()])
        let events = drive(&machine, from: -100, to: 900, speed: 15)
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].taskId, "tsk_p")
        XCTAssertEqual(events[0].segmentId, "seg:p")
        XCTAssertEqual(events[0].meanSpeedMps, 15, accuracy: 0.5)
        XCTAssertFalse(events[0].slow)
        // At most once per task.
        XCTAssertTrue(drive(&machine, from: -100, to: 900, speed: 15, startingAt: 200).isEmpty)
    }

    func testReverseDirectionCounts() {
        var machine = PassiveTraversal()
        machine.track([tracked()])
        var events: [PassiveTraversal.Traversed] = []
        var east = 900.0
        var t = 0.0
        while east >= -100 {
            events += machine.feed(BoardFix(coord: pt(east), at: t0.addingTimeInterval(t), speedMps: 12))
            east -= 12
            t += 1
        }
        XCTAssertEqual(events.count, 1)
    }

    func testSlowTraversalIsFlagged() {
        var machine = PassiveTraversal()  // slow_ratio 0.5 x 56 km/h = 7.8 m/s
        machine.track([tracked()])
        let events = drive(&machine, from: -50, to: 900, speed: 6)
        XCTAssertEqual(events.count, 1)
        XCTAssertTrue(events[0].slow)
    }

    func testWalkingSpeedIsNotAPass() {
        var machine = PassiveTraversal()
        machine.track([tracked()])
        XCTAssertTrue(drive(&machine, from: -20, to: 900, speed: 1.5).isEmpty)
    }

    func testJoiningMidwayOrLeavingEarlyIsNotAPass() {
        var machine = PassiveTraversal()
        machine.track([tracked()])
        XCTAssertTrue(drive(&machine, from: 300, to: 900, speed: 15).isEmpty)
        machine.reset()
        machine.track([tracked()])
        // Enters at the start, turns off the road halfway.
        var events = drive(&machine, from: -50, to: 400, speed: 15)
        events += machine.feed(BoardFix(coord: pt(420, 300), at: t0.addingTimeInterval(100), speedMps: 15))
        events += drive(&machine, from: 440, to: 900, speed: 15, startingAt: 101)
        XCTAssertTrue(events.isEmpty)
    }

    func testGapInsideBufferEndsTraversal() {
        var machine = PassiveTraversal()
        machine.track([tracked()])
        var events = machine.feed(BoardFix(coord: pt(0), at: t0, speedMps: 15))
        events += machine.feed(BoardFix(coord: pt(780), at: t0.addingTimeInterval(120), speedMps: 15))
        XCTAssertTrue(events.isEmpty)
    }

    // MARK: Stall

    func testStallAfterStallSecondsOnly() {
        var detector = StallDetector()
        detector.track([tracked()])
        var due: [String] = []
        for s in stride(from: 0.0, through: 100, by: 10) {
            due += detector.feed(BoardFix(coord: pt(300), at: t0.addingTimeInterval(s), speedMps: 0), stallS: 120)
        }
        XCTAssertTrue(due.isEmpty)
        due = detector.feed(BoardFix(coord: pt(300), at: t0.addingTimeInterval(130), speedMps: 0), stallS: 120)
        XCTAssertEqual(due, ["tsk_p"])
        // Asked once.
        XCTAssertTrue(detector.feed(BoardFix(coord: pt(300), at: t0.addingTimeInterval(300), speedMps: 0), stallS: 120).isEmpty)
    }

    func testMovingOrOutsideResetsStall() {
        var detector = StallDetector()
        detector.track([tracked()])
        _ = detector.feed(BoardFix(coord: pt(300), at: t0, speedMps: 0), stallS: 120)
        _ = detector.feed(BoardFix(coord: pt(310), at: t0.addingTimeInterval(60), speedMps: 8), stallS: 120)
        XCTAssertTrue(detector.feed(BoardFix(coord: pt(310), at: t0.addingTimeInterval(130), speedMps: 0), stallS: 120).isEmpty)
        // Stopped outside the buffer never counts.
        var outside = StallDetector()
        outside.track([tracked()])
        _ = outside.feed(BoardFix(coord: pt(300, 200), at: t0, speedMps: 0), stallS: 120)
        XCTAssertTrue(outside.due(now: t0.addingTimeInterval(500), stallS: 120).isEmpty)
    }

    func testStallDueWithoutNewFix() {
        var detector = StallDetector()
        detector.track([tracked()])
        _ = detector.feed(BoardFix(coord: pt(300), at: t0, speedMps: 0), stallS: 120)
        XCTAssertEqual(detector.due(now: t0.addingTimeInterval(121), stallS: 120), ["tsk_p"])
    }
}
