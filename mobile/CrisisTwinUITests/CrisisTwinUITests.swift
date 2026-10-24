import XCTest

/// Headless live-drill checks against a running local backend and drill (see mobile/README.md).
/// State is driven through the API with the controller token; the UI is driven through
/// accessibility. Screenshots are attached and, with `QA_SHOTS`, also written to that folder.
/// Set the simulator location first: `xcrun simctl location <id> set <lat>,<lon>`.
final class CrisisTwinUITests: XCTestCase {
    private let incident = "camp-2018-drill"
    private var base: String { ProcessInfo.processInfo.environment["QA_API"] ?? "http://localhost:8000/api/live" }
    private var controller: String { ProcessInfo.processInfo.environment["QA_CONTROLLER"] ?? "dev-controller" }
    private let paradise = (lon: -121.6219, lat: 39.7596)

    override func setUp() {
        continueAfterFailure = false
    }

    // MARK: Checks

    /// 1. Home in a zone with no order shows the Ready card (and the fire trend once it exists).
    /// Run with the simulator outside every ordered zone, for example 39.7255,-121.8083.
    func testHomeNoOrder() {
        let app = launch(screen: "home")
        let ready = app.staticTexts["Ready"].waitForExistence(timeout: 45)
        shot("home-no-order", app)
        XCTAssertTrue(ready, "Ready card")
        let trend = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'in the last'")).firstMatch
        attachNote("fire trend line present: \(trend.exists)")
    }

    /// 2. The help button follows the controller's handling of the request.
    func testHelpStates() throws {
        let app = launch(screen: "home", extra: ["-scroll", "bottom"])
        let help = app.buttons["Need help"]
        XCTAssertTrue(help.waitForExistence(timeout: 45), "Need help button")
        shot("help-0-idle", app)
        help.tap()
        shot("help-1-confirm", app)
        app.buttons["Send location"].tap()
        XCTAssertTrue(app.buttons["Help requested"].waitForExistence(timeout: 15), "Help requested")
        shot("help-2-requested", app)

        let checkin = try myHelpCheckin()
        _ = try post("checkins/\(checkin)/help", ["action": "acknowledge"])
        XCTAssertTrue(app.buttons["Request seen"].waitForExistence(timeout: 20), "Request seen")
        shot("help-3-seen", app)
        _ = try post("checkins/\(checkin)/help", ["action": "assign"])
        XCTAssertTrue(app.buttons["Responder assigned"].waitForExistence(timeout: 20), "Responder assigned")
        shot("help-4-assigned", app)
        _ = try post("checkins/\(checkin)/help", ["action": "resolve"])
        XCTAssertTrue(app.buttons["Need help"].waitForExistence(timeout: 20), "Back to Need help")
        shot("help-5-resolved", app)
    }

    /// 3. Responder: join with the invite, share location, accept assist and verify tasks, route
    /// card, the route on Map, and Done on the assist task.
    func testResponderTasks() throws {
        // The Responder screen, pushed in Plan; it shows the join form until this phone has joined.
        let app = launch(screen: "responder")
        let code = app.textFields["Invite code"]
        if code.waitForExistence(timeout: 10) {
            code.tap()
            code.typeText("DRILL")
            shot("resp-0-join", app)
            app.buttons["Join as responder"].firstMatch.tap()
        }
        let share = app.switches["Share my location"]
        XCTAssertTrue(share.waitForExistence(timeout: 15), "Joined")
        if (share.value as? String) != "1" { share.tap() }
        shot("resp-1-joined", app)

        // A help request to assist, and a verify task on a road next to it.
        app.terminate()
        let app2 = launch(screen: "home")
        XCTAssertTrue(app2.buttons["Need help"].waitForExistence(timeout: 45))
        app2.buttons["Need help"].tap()
        app2.buttons["Send location"].tap()
        XCTAssertTrue(app2.buttons["Help requested"].waitForExistence(timeout: 15))
        let checkin = try myHelpCheckin()
        _ = try post("checkins/\(checkin)/help", ["action": "assign"])
        _ = try post("incidents/\(incident)/tasks", [
            "assignee": NSNull(), "report_ids": [], "note": "QA verify",
            "target": ["coord": [paradise.lon + 0.004, paradise.lat + 0.003]],
        ])

        let tasks = app2.tabBars.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 20), "Tasks tab for responder")
        tasks.tap()
        let assist = app2.staticTexts["Help a resident"].firstMatch
        XCTAssertTrue(assist.waitForExistence(timeout: 20), "assist task")
        shot("resp-2-tasks", app2)
        // Only this test's two tasks (the newest, so first): never other responders' open tasks.
        for _ in 0..<2 where app2.buttons["Accept"].exists {
            app2.buttons["Accept"].firstMatch.tap()
            sleep(2)
        }
        let routeLabel = app2.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'No route' OR label CONTAINS 'via'")).firstMatch
        XCTAssertTrue(routeLabel.waitForExistence(timeout: 40), "route card")
        shot("resp-3-route", app2)
        attachNote("route label: \(routeLabel.label)")
        app2.buttons["Show on map"].firstMatch.tap()
        sleep(4)
        shot("resp-4-map", app2)
        app2.tabBars.buttons["Tasks"].tap()
        let done = app2.buttons["Done"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 10), "Done on assist")
        done.tap()
        sleep(3)
        shot("resp-5-after-done", app2)
        XCTAssertFalse(app2.staticTexts["Help a resident"].exists, "assist task closed")
    }

    /// 3b. The dotted route line to a task. Run as a responder (testResponderTasks first) with the
    /// simulator outside the fire, for example 39.7255,-121.8083.
    func testResponderRouteLine() throws {
        let app = launch(screen: "tasks", extra: ["-join", "DRILL"])
        XCTAssertTrue(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 30), "Tasks tab")
        _ = try post("incidents/\(incident)/tasks", [
            "assignee": NSNull(), "report_ids": [], "note": "QA route",
            "target": ["coord": [-121.7883, 39.7255]],
        ])
        let accept = app.buttons["Accept"].firstMatch
        XCTAssertTrue(accept.waitForExistence(timeout: 20), "new task")
        accept.tap()
        let routeLabel = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'No route' OR label CONTAINS 'via'")).firstMatch
        let found = routeLabel.waitForExistence(timeout: 60)
        shot("route-0-card", app)
        XCTAssertTrue(found, "route card")
        attachNote("route label: \(routeLabel.label)")
        app.buttons["Show on map"].firstMatch.tap()
        sleep(5)
        shot("route-1-map", app)
    }

    // MARK: Helpers

    private func launch(screen: String, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", screen] + extra
        app.launch()
        // The location prompt (shown once per install) lives in SpringBoard.
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow While Using App"]
        if allow.waitForExistence(timeout: 6) { allow.tap() }
        return app
    }

    private func shot(_ name: String, _ app: XCUIApplication) {
        let screenshot = app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = ProcessInfo.processInfo.environment["QA_SHOTS"] {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    private func attachNote(_ text: String) {
        let attachment = XCTAttachment(string: text)
        attachment.lifetime = .keepAlways
        add(attachment)
        print("QA: \(text)")
    }

    /// The need_help check-in at this simulator's location (the phone sends the fix it has).
    private func myHelpCheckin() throws -> String {
        for _ in 0..<10 {
            let command = try request("incidents/\(incident)/command", method: "GET", body: nil)
            let checkins = (command["checkins"] as? [String: Any])?["need_help"] as? [[String: Any]] ?? []
            let mine = checkins.first {
                guard let coord = $0["coord"] as? [Double], coord.count == 2,
                      let help = $0["help"] as? [String: Any], help["status"] as? String != "resolved" else { return false }
                return abs(coord[0] - paradise.lon) < 0.01 && abs(coord[1] - paradise.lat) < 0.01
            }
            if let id = mine?["id"] as? String { return id }
            sleep(1)
        }
        throw NSError(domain: "qa", code: 1, userInfo: [NSLocalizedDescriptionKey: "no need_help check-in near the simulator location"])
    }

    @discardableResult
    private func post(_ path: String, _ body: [String: Any]) throws -> [String: Any] {
        try request(path, method: "POST", body: body)
    }

    private func request(_ path: String, method: String, body: [String: Any]?) throws -> [String: Any] {
        var req = URLRequest(url: URL(string: "\(base)/\(path)")!)
        req.httpMethod = method
        req.setValue("Bearer \(controller)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        var result: Result<[String: Any], Error> = .failure(NSError(domain: "qa", code: 2))
        let done = expectation(description: path)
        URLSession.shared.dataTask(with: req) { data, response, error in
            defer { done.fulfill() }
            if let error { result = .failure(error); return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
            result = status < 300 ? .success(json)
                : .failure(NSError(domain: "qa", code: status, userInfo: [NSLocalizedDescriptionKey: "HTTP \(status) \(path)"]))
        }.resume()
        wait(for: [done], timeout: 15)
        return try result.get()
    }
}
