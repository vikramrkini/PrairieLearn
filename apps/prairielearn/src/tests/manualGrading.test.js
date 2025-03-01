// @ts-check
const { assert } = require('chai');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const _ = require('lodash');
const { step } = require('mocha-steps');

const { config } = require('../lib/config');
const fetch = require('node-fetch').default;
const helperServer = require('./helperServer');
const sqldb = require('@prairielearn/postgres');
const sql = sqldb.loadSqlEquiv(__filename);
const { setUser, parseInstanceQuestionId, saveOrGrade } = require('./helperClient');
const { TEST_COURSE_PATH } = require('../lib/paths');
const { features } = require('../lib/features/index');

const siteUrl = 'http://localhost:' + config.serverPort;
const baseUrl = siteUrl + '/pl';
const defaultUser = {
  authUid: config.authUid,
  authName: config.authName,
  authUin: config.authUin,
};

const fibonacciSolution = fs.readFileSync(
  path.resolve(TEST_COURSE_PATH, 'questions', 'externalGrade', 'codeUpload', 'tests', 'ans.py'),
);

const mockStudents = [
  { authUid: 'student1', authName: 'Student User 1', authUin: '00000001' },
  { authUid: 'student2', authName: 'Student User 2', authUin: '00000002' },
  { authUid: 'student3', authName: 'Student User 3', authUin: '00000003' },
  { authUid: 'student4', authName: 'Student User 4', authUin: '00000004' },
];

const mockStaff = [
  { authUid: 'staff1', authName: 'Staff User 1', authUin: 'STAFF001' },
  { authUid: 'staff2', authName: 'Staff User 2', authUin: 'STAFF002' },
  { authUid: 'staff3', authName: 'Staff User 3', authUin: 'STAFF003' },
  { authUid: 'staff4', authName: 'Staff User 4', authUin: 'STAFF004' },
];

const assessmentTitle = 'Homework for Internal, External, Manual grading methods';
const manualGradingQuestionTitle = 'Manual Grading: Fibonacci function, file upload';

/**
 * @param {object} user student or instructor user to load page by
 * @returns {Promise<string>} Returns "Homework for Internal, External, Manual grading methods" page text
 */
const loadHomeworkPage = async (user) => {
  setUser(user);
  const studentCourseInstanceUrl = baseUrl + '/course_instance/1';
  const courseInstanceBody = await (await fetch(studentCourseInstanceUrl)).text();
  const $courseInstancePage = cheerio.load(courseInstanceBody);
  const hm9InternalExternalManualUrl =
    siteUrl + $courseInstancePage(`a:contains("${assessmentTitle}")`).attr('href');
  let res = await fetch(hm9InternalExternalManualUrl);
  assert.equal(res.ok, true);
  return res.text();
};

/**
 * @param {object} user student or instructor user to load page by
 * @returns {Promise<string>} student URL for manual grading question
 */
const loadHomeworkQuestionUrl = async (user) => {
  const hm1Body = await loadHomeworkPage(user);
  const $hm1Body = cheerio.load(hm1Body);
  return siteUrl + $hm1Body(`a:contains("${manualGradingQuestionTitle}")`).attr('href');
};

/**
 * Gets the score text for the first submission panel on the page.
 *
 * @param {cheerio.Root} $
 * @returns {string}
 */
const getLatestSubmissionStatus = ($) => {
  return $('[data-testid="submission-status"] .badge').first().text();
};

let iqUrl, iqId;
let instancesAssessmentUrl;
let manualGradingAssessmentUrl;
let manualGradingAssessmentQuestionUrl;
let manualGradingIQUrl;
let manualGradingNextUngradedUrl;
let $manualGradingPage;
let score_percent, score_points, adjust_points;
let feedback_note;
let rubric_items;
let selected_rubric_items;

const submitGradeForm = async (method = 'rubric') => {
  const manualGradingIQPage = await (await fetch(manualGradingIQUrl)).text();
  const $manualGradingIQPage = cheerio.load(manualGradingIQPage);
  const form = $manualGradingIQPage('form[name=manual-grading-form]');
  await fetch(manualGradingIQUrl, {
    method: 'POST',
    headers: { 'Content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([
      ...Object.entries({
        __action: 'add_manual_grade',
        __csrf_token: form.find('input[name=__csrf_token]').val(),
        modified_at: form.find('input[name=modified_at]').val(),
        score_manual_points: (method === 'points' ? score_points : score_points - 1).toString(),
        score_manual_percent: (method === 'percentage'
          ? score_percent
          : score_percent - 10
        ).toString(),
        submission_note: feedback_note,
      }),
      ...(adjust_points ? [['score_manual_adjust_points', adjust_points]] : []),
      ...(method === 'percentage' ? [['use_score_perc', 'on']] : []),
      // Uses array since it requires the same key multiple times
      ...(selected_rubric_items || []).map((index) => [
        'rubric_item_selected_manual',
        rubric_items[index].id,
      ]),
    ]).toString(),
  });
};

const checkGradingResults = (assigned_grader, grader) => {
  step('manual grading page for instance question lists updated values', async () => {
    setUser(defaultUser);
    const manualGradingIQPage = await (await fetch(manualGradingIQUrl)).text();
    const $manualGradingIQPage = cheerio.load(manualGradingIQPage);
    const form = $manualGradingIQPage('form[name=manual-grading-form]');
    // The percentage input is not checked because its value is updated via client-side JS, which is
    // currently not supported by the test suite
    assert.equal(form.find('input[name=score_manual_points]').val(), score_points);
    assert.equal(form.find('textarea').text(), feedback_note);

    if (rubric_items) {
      rubric_items.forEach((item, index) => {
        const checkbox = form.find(`.js-selectable-rubric-item[value="${item.id}"]`);
        assert.equal(checkbox.length, 1);
        assert.equal(checkbox.is(':checked'), selected_rubric_items.includes(index));
      });
      assert.equal(form.find('input[name=score_manual_adjust_points]').val(), adjust_points || 0);
    } else {
      assert.equal(form.find('.js-selectable-rubric-item').length, 0);
      assert.equal(form.find('input[name=score_manual_adjust_points]').length, 0);
    }
  });

  step('manual grading page for assessment question lists updated values', async () => {
    setUser(defaultUser);
    const manualGradingAQData = await (
      await fetch(manualGradingAssessmentQuestionUrl + '/instances.json')
    ).text();
    const instanceList = JSON.parse(manualGradingAQData)?.instance_questions;
    assert(instanceList);
    assert.lengthOf(instanceList, 1);
    assert.equal(instanceList[0].id, iqId);
    assert.isNotOk(instanceList[0].requires_manual_grading);
    assert.equal(instanceList[0].assigned_grader, assigned_grader.user_id);
    assert.equal(instanceList[0].assigned_grader_name, assigned_grader.authName);
    assert.equal(instanceList[0].last_grader, grader.user_id);
    assert.equal(instanceList[0].last_grader_name, grader.authName);
    assert.closeTo(instanceList[0].score_perc, score_percent, 0.01);
    assert.closeTo(instanceList[0].points, score_points, 0.01);
    assert.closeTo(instanceList[0].manual_points, score_points, 0.01);
    assert.closeTo(instanceList[0].auto_points, 0, 0.01);
  });

  step('manual grading page for assessment does NOT show graded instance for grading', async () => {
    setUser(mockStaff[0]);
    const manualGradingPage = await (await fetch(manualGradingAssessmentUrl)).text();
    $manualGradingPage = cheerio.load(manualGradingPage);
    const row = $manualGradingPage(`tr:contains("${manualGradingQuestionTitle}")`);
    assert.equal(row.length, 1);
    const count = row.find('td[data-testid="iq-to-grade-count"]').text().replace(/\s/g, '');
    assert.equal(count, '0/1');
    const nextButton = row.find('.btn:contains("next submission")');
    assert.equal(nextButton.length, 0);
  });

  step('next ungraded button should point to general page after grading', async () => {
    setUser(mockStaff[0]);
    let nextUngraded = await fetch(manualGradingNextUngradedUrl, { redirect: 'manual' });
    assert.equal(nextUngraded.status, 302);
    assert.equal(nextUngraded.headers.get('location'), manualGradingAssessmentQuestionUrl);
    setUser(mockStaff[1]);
    nextUngraded = await fetch(manualGradingNextUngradedUrl, { redirect: 'manual' });
    assert.equal(nextUngraded.status, 302);
    assert.equal(nextUngraded.headers.get('location'), manualGradingAssessmentQuestionUrl);
  });

  step('student view should have the new score/feedback/rubric', async () => {
    iqUrl = await loadHomeworkQuestionUrl(mockStudents[0]);
    const questionsPage = await (await fetch(iqUrl)).text();
    const $questionsPage = cheerio.load(questionsPage);
    const feedbackBlock = $questionsPage('[data-testid="submission-with-feedback"]').first();

    assert.equal(
      getLatestSubmissionStatus($questionsPage),
      `manual grading: ${Math.floor(score_percent)}%`,
    );
    assert.equal(
      $questionsPage(
        '#question-score-panel tr:contains("Total points") [data-testid="awarded-points"]',
      )
        .first()
        .text()
        .trim(),
      `${score_points}`,
    );
    assert.equal(
      feedbackBlock.find('[data-testid="feedback-body"]').first().text().trim(),
      feedback_note,
    );

    if (!rubric_items) {
      const container = feedbackBlock.find(`[data-testid^="rubric-item-container-"]`);
      assert.equal(container.length, 0);
    } else {
      rubric_items.forEach((item, index) => {
        const container = feedbackBlock.find(`[data-testid="rubric-item-container-${item.id}"]`);
        assert.equal(container.length, 1);
        assert.equal(
          container.find('input[type="checkbox"]').is(':checked'),
          selected_rubric_items.includes(index),
        );
        assert.equal(
          container.find('[data-testid="rubric-item-points"]').text().trim(),
          `[${item.points >= 0 ? '+' : ''}${item.points}]`,
        );
        assert.equal(
          container.find('[data-testid="rubric-item-description"]').html()?.trim(),
          item.description_render ?? item.description,
        );
        if (item.explanation) {
          assert.equal(
            container.find('[data-testid="rubric-item-explanation"]').attr('data-content'),
            item.explanation_render ?? `<p>${item.explanation}</p>`,
          );
        } else {
          assert.equal(container.find('[data-testid="rubric-item-explanation"]').length, 0);
        }
      });
    }
    if (adjust_points) {
      assert.equal(
        feedbackBlock.find('[data-testid="rubric-adjust-points"]').text().trim(),
        `[${adjust_points >= 0 ? '+' : ''}${adjust_points}]`,
      );
    } else {
      assert.equal(feedbackBlock.find('[data-testid="rubric-adjust-points"]').length, 0);
    }
  });
};

const checkSettingsResults = (starting_points, min_points, max_extra_points) => {
  step('rubric settings modal should update with new values', async () => {
    const manualGradingIQPage = await (await fetch(manualGradingIQUrl)).text();
    const $manualGradingIQPage = cheerio.load(manualGradingIQPage);
    const form = $manualGradingIQPage('form[name=rubric-settings]');

    assert.equal(
      form.find(`input[name="starting_points"][value="${starting_points}"]`).is(':checked'),
      true,
    );
    assert.equal(form.find('input[name="max_extra_points"]').val(), max_extra_points.toString());
    assert.equal(form.find('input[name="min_points"]').val(), min_points.toString());

    const idFields = form.find(`input[name^="rubric_item"][name$="[id]"]`);

    rubric_items.forEach((item, index) => {
      const idField = $manualGradingIQPage(idFields.get(index));
      assert.equal(idField.length, 1);
      if (!item.id) {
        item.id = idField.val();
      }
      assert.equal(idField.val(), item.id);
      assert.equal(idField.attr('name'), `rubric_item[cur${item.id}][id]`);
      const points = form.find(`[name="rubric_item[cur${item.id}][points]"]`);
      assert.equal(points.val(), item.points);
      const description = form.find(`[name="rubric_item[cur${item.id}][description]"]`);
      assert.equal(description.val(), item.description);
      const explanation = form.find(
        `label[data-input-name="rubric_item[cur${item.id}][explanation]"]`,
      );
      assert.equal(explanation.attr('data-current-value') ?? '', item.explanation ?? '');
      const graderNote = form.find(
        `label[data-input-name="rubric_item[cur${item.id}][grader_note]"]`,
      );
      assert.equal(graderNote.attr('data-current-value') ?? '', item.grader_note ?? '');
    });
  });

  step('grading panel should have proper values for rubric', async () => {
    const manualGradingIQPage = await (await fetch(manualGradingIQUrl)).text();
    const $manualGradingIQPage = cheerio.load(manualGradingIQPage);
    const form = $manualGradingIQPage('form[name=manual-grading-form]');

    rubric_items.forEach((item) => {
      const checkbox = form.find(`.js-selectable-rubric-item[value="${item.id}"]`);
      assert.equal(checkbox.length, 1);
      const container = checkbox.parents('.js-selectable-rubric-item-label');
      assert.equal(container.length, 1);
      assert.equal(
        container.find('[data-testid="rubric-item-points"]').text().trim(),
        `[${item.points >= 0 ? '+' : ''}${item.points}]`,
      );
      assert.equal(
        container.find('[data-testid="rubric-item-description"]').html()?.trim(),
        item.description_render ?? item.description,
      );
      assert.equal(
        container.find('[data-testid="rubric-item-explanation"]').html()?.trim(),
        item.explanation_render ?? (item.explanation ? `<p>${item.explanation}</p>` : ''),
      );
      assert.equal(
        container.find('[data-testid="rubric-item-grader-note"]').html()?.trim(),
        item.grader_note_render ?? (item.grader_note ? `<p>${item.grader_note}</p>` : ''),
      );
    });
  });
};

const buildRubricItemFields = (items) =>
  _.fromPairs(
    _.flatMap(
      _.toPairs(_.mapKeys(items, (item, index) => (item.id ? `cur${item.id}` : `new${index}`))),
      ([key, item], order) =>
        _.map(_.toPairs({ order, ...item }), ([field, value]) => [
          `rubric_item[${key}][${field}]`,
          value,
        ]),
    ),
  );

describe('Manual Grading', function () {
  this.timeout(80000);

  before('set up testing server', helperServer.before());
  after('shut down testing server', helperServer.after);

  before('ensure course has manual grading enabled', async () => {
    await features.enable('manual-grading-rubrics');
  });

  before('build assessment manual grading page URL', async () => {
    const assessments = (await sqldb.queryAsync(sql.get_assessment, {})).rows;
    assert.lengthOf(assessments, 1);
    manualGradingAssessmentUrl = `${baseUrl}/course_instance/1/instructor/assessment/${assessments[0].id}/manual_grading`;
    instancesAssessmentUrl = `${baseUrl}/course_instance/1/instructor/assessment/${assessments[0].id}/instances`;
  });

  before('add staff users', async () => {
    await Promise.all(
      mockStaff.map(async (staff) => {
        const courseStaffParams = [1, staff.authUid, 'None', 1];
        const courseStaffResult = await sqldb.callAsync(
          'course_permissions_insert_by_user_uid',
          courseStaffParams,
        );
        assert.equal(courseStaffResult.rowCount, 1);
        staff.user_id = courseStaffResult.rows[0].user_id;
        const ciStaffParams = [1, staff.user_id, 1, 'Student Data Editor', 1];
        const ciStaffResult = await sqldb.callAsync(
          'course_instance_permissions_insert',
          ciStaffParams,
        );
        assert.equal(ciStaffResult.rowCount, 1);
      }),
    );
  });

  after('reset default user', () => setUser(defaultUser));

  describe('Submit and grade a manually graded question', () => {
    describe('Student submission tags question for grading', () => {
      step('load page as student', async () => {
        iqUrl = await loadHomeworkQuestionUrl(mockStudents[0]);
        iqId = parseInstanceQuestionId(iqUrl);
        manualGradingIQUrl = `${manualGradingAssessmentUrl}/instance_question/${iqId}`;

        const instance_questions = (await sqldb.queryAsync(sql.get_instance_question, { iqId }))
          .rows;
        assert.lengthOf(instance_questions, 1);
        assert.equal(instance_questions[0].requires_manual_grading, false);
      });

      step('submit an answer to the question', async () => {
        const gradeRes = await saveOrGrade(iqUrl, {}, 'save', [
          { name: 'fib.py', contents: Buffer.from(fibonacciSolution).toString('base64') },
        ]);
        const questionsPage = await gradeRes.text();
        const $questionsPage = cheerio.load(questionsPage);

        assert.equal(gradeRes.status, 200);
        assert.equal(
          getLatestSubmissionStatus($questionsPage),
          'manual grading: waiting for grading',
        );
      });

      step('should tag question as requiring grading', async () => {
        const instanceQuestions = (await sqldb.queryAsync(sql.get_instance_question, { iqId }))
          .rows;
        assert.lengthOf(instanceQuestions, 1);
        assert.equal(instanceQuestions[0].requires_manual_grading, true);
      });
    });

    describe('Manual grading behavior while instance is open', () => {
      step('manual grading page should warn about an open instance', async () => {
        setUser(defaultUser);
        const manualGradingPage = await (await fetch(manualGradingAssessmentUrl)).text();
        $manualGradingPage = cheerio.load(manualGradingPage);
        const row = $manualGradingPage('div.alert:contains("has one open instance")');
        assert.equal(row.length, 1);
      });

      step('manual grading page should list one question requiring grading', async () => {
        const row = $manualGradingPage(`tr:contains("${manualGradingQuestionTitle}")`);
        assert.equal(row.length, 1);
        const count = row.find('td[data-testid="iq-to-grade-count"]').text().replace(/\s/g, '');
        assert.equal(count, '1/1');
        const nextButton = row.find('.btn:contains("next submission")');
        assert.equal(nextButton.length, 1);
        manualGradingAssessmentQuestionUrl =
          siteUrl + row.find(`a:contains("${manualGradingQuestionTitle}")`).attr('href');
        manualGradingNextUngradedUrl = manualGradingAssessmentQuestionUrl + '/next_ungraded';
      });

      step(
        'manual grading page for assessment question should warn about an open instance',
        async () => {
          setUser(defaultUser);
          const manualGradingAQPage = await (
            await fetch(manualGradingAssessmentQuestionUrl)
          ).text();
          const $manualGradingAQPage = cheerio.load(manualGradingAQPage);
          const row = $manualGradingAQPage('div.alert:contains("has one open instance")');
          assert.equal(row.length, 1);
        },
      );

      step('manual grading page for assessment question should list one instance', async () => {
        setUser(defaultUser);
        const manualGradingAQData = await (
          await fetch(manualGradingAssessmentQuestionUrl + '/instances.json')
        ).text();
        const instanceList = JSON.parse(manualGradingAQData)?.instance_questions;
        assert(instanceList);
        assert.lengthOf(instanceList, 1);
        assert.equal(instanceList[0].id, iqId);
        assert.isOk(instanceList[0].requires_manual_grading);
        assert.isNotOk(instanceList[0].assigned_grader);
        assert.isNotOk(instanceList[0].assigned_grader_name);
        assert.isNotOk(instanceList[0].last_grader);
        assert.isNotOk(instanceList[0].last_grader_name);
      });

      step(
        'manual grading page for instance question should warn about an open instance',
        async () => {
          setUser(defaultUser);
          const manualGradingIQPage = await (await fetch(manualGradingIQUrl)).text();
          const $manualGradingIQPage = cheerio.load(manualGradingIQPage);
          const row = $manualGradingIQPage('div.alert:contains("is still open")');
          assert.equal(row.length, 1);
        },
      );
    });

    describe('Manual grading behaviour when instance is closed', () => {
      step('close assessment', async () => {
        setUser(defaultUser);
        const instancesBody = await (await fetch(instancesAssessmentUrl)).text();
        const $instancesBody = cheerio.load(instancesBody);
        const token = $instancesBody('form[name=grade-all-form]')
          .find('input[name=__csrf_token]')
          .val();
        await fetch(instancesAssessmentUrl, {
          method: 'POST',
          headers: { 'Content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            __action: 'close_all',
            __csrf_token: token,
          }).toString(),
        });
      });

      step('manual grading page should NOT warn about an open instance', async () => {
        setUser(defaultUser);
        const manualGradingPage = await (await fetch(manualGradingAssessmentUrl)).text();
        $manualGradingPage = cheerio.load(manualGradingPage);
        const row = $manualGradingPage('div.alert:contains("has one open instance")');
        assert.equal(row.length, 0);
      });

      step(
        'manual grading page for assessment question should NOT warn about an open instance',
        async () => {
          setUser(defaultUser);
          const manualGradingAQPage = await (
            await fetch(manualGradingAssessmentQuestionUrl)
          ).text();
          const $manualGradingAQPage = cheerio.load(manualGradingAQPage);
          const row = $manualGradingAQPage('div.alert:contains("has one open instance")');
          assert.equal(row.length, 0);
        },
      );

      step(
        'manual grading page for instance question should NOT warn about an open instance',
        async () => {
          setUser(defaultUser);
          const manualGradingIQPage = await (await fetch(manualGradingIQUrl)).text();
          const $manualGradingIQPage = cheerio.load(manualGradingIQPage);
          const row = $manualGradingIQPage('div.alert:contains("is still open")');
          assert.equal(row.length, 0);
        },
      );

      step('next ungraded button should point to existing instance for all graders', async () => {
        setUser(defaultUser);
        let nextUngraded = await fetch(manualGradingNextUngradedUrl, { redirect: 'manual' });
        assert.equal(nextUngraded.status, 302);
        assert.equal(nextUngraded.headers.get('location'), manualGradingIQUrl);
        setUser(mockStaff[0]);
        nextUngraded = await fetch(manualGradingNextUngradedUrl, { redirect: 'manual' });
        assert.equal(nextUngraded.status, 302);
        assert.equal(nextUngraded.headers.get('location'), manualGradingIQUrl);
        setUser(mockStaff[1]);
        nextUngraded = await fetch(manualGradingNextUngradedUrl, { redirect: 'manual' });
        assert.equal(nextUngraded.status, 302);
        assert.equal(nextUngraded.headers.get('location'), manualGradingIQUrl);
      });
    });

    describe('Assigning grading to staff members', () => {
      step('tag question to specific grader', async () => {
        setUser(defaultUser);
        const manualGradingAQPage = await (await fetch(manualGradingAssessmentQuestionUrl)).text();
        const $manualGradingAQPage = cheerio.load(manualGradingAQPage);
        const token = $manualGradingAQPage('form[name=grading-form]')
          .find('input[name=__csrf_token]')
          .val();

        await fetch(manualGradingAssessmentQuestionUrl, {
          method: 'POST',
          headers: { 'Content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            __action: 'batch_action',
            __csrf_token: token,
            batch_action_data: JSON.stringify({ assigned_grader: mockStaff[0].user_id }),
            instance_question_id: iqId,
          }).toString(),
        });
      });

      step('manual grading page for assessment question should list tagged grader', async () => {
        setUser(defaultUser);
        const manualGradingAQData = await (
          await fetch(manualGradingAssessmentQuestionUrl + '/instances.json')
        ).text();
        const instanceList = JSON.parse(manualGradingAQData)?.instance_questions;
        assert(instanceList);
        assert.lengthOf(instanceList, 1);
        assert.equal(instanceList[0].id, iqId);
        assert.isOk(instanceList[0].requires_manual_grading);
        assert.equal(instanceList[0].assigned_grader, mockStaff[0].user_id);
        assert.equal(instanceList[0].assigned_grader_name, mockStaff[0].authName);
        assert.isNotOk(instanceList[0].last_grader);
        assert.isNotOk(instanceList[0].last_grader_name);
      });

      step('manual grading page should show next ungraded button for assigned grader', async () => {
        setUser(mockStaff[0]);
        const manualGradingPage = await (await fetch(manualGradingAssessmentUrl)).text();
        $manualGradingPage = cheerio.load(manualGradingPage);
        const row = $manualGradingPage(`tr:contains("${manualGradingQuestionTitle}")`);
        assert.equal(row.length, 1);
        const count = row.find('td[data-testid="iq-to-grade-count"]').text().replace(/\s/g, '');
        assert.equal(count, '1/1');
        const nextButton = row.find('.btn:contains("next submission")');
        assert.equal(nextButton.length, 1);
      });

      step(
        'manual grading page should NOT show next ungraded button for non-assigned grader',
        async () => {
          setUser(mockStaff[1]);
          const manualGradingPage = await (await fetch(manualGradingAssessmentUrl)).text();
          $manualGradingPage = cheerio.load(manualGradingPage);
          const row = $manualGradingPage(`tr:contains("${manualGradingQuestionTitle}")`);
          assert.equal(row.length, 1);
          const count = row.find('td[data-testid="iq-to-grade-count"]').text().replace(/\s/g, '');
          assert.equal(count, '1/1');
          const nextButton = row.find('.btn:contains("next submission")');
          assert.equal(nextButton.length, 0);
        },
      );

      step(
        'next ungraded button should point to existing instance for assigned grader',
        async () => {
          setUser(mockStaff[0]);
          const nextUngraded = await fetch(manualGradingNextUngradedUrl, { redirect: 'manual' });
          assert.equal(nextUngraded.status, 302);
          assert.equal(nextUngraded.headers.get('location'), manualGradingIQUrl);
        },
      );

      step(
        'next ungraded button should point to general page for non-assigned graders',
        async () => {
          setUser(mockStaff[1]);
          const nextUngraded = await fetch(manualGradingNextUngradedUrl, { redirect: 'manual' });
          assert.equal(nextUngraded.status, 302);
          assert.equal(nextUngraded.headers.get('location'), manualGradingAssessmentQuestionUrl);
        },
      );
    });

    describe('Submit a grade using percentage (whole)', () => {
      step('submit a grade using percentage', async () => {
        setUser(mockStaff[2]);
        score_percent = 30;
        score_points = (score_percent * 6) / 100;
        feedback_note = 'Test feedback note';
        await submitGradeForm('percentage');
      });

      checkGradingResults(mockStaff[0], mockStaff[2]);
    });

    describe('Submit a grade using percentage (float)', () => {
      step('submit a grade using percentage', async () => {
        setUser(mockStaff[2]);
        score_percent = 20.5;
        score_points = (score_percent * 6) / 100;
        feedback_note = 'Test feedback note';
        await submitGradeForm('percentage');
      });

      checkGradingResults(mockStaff[0], mockStaff[2]);
    });

    describe('Submit a grade using points (whole)', () => {
      step('submit a grade using points', async () => {
        setUser(mockStaff[1]);
        score_points = 4;
        score_percent = Math.round((score_points / 6) * 10000) / 100;
        feedback_note = 'Test feedback note updated';
        await submitGradeForm('points');
      });

      checkGradingResults(mockStaff[0], mockStaff[1]);
    });

    describe('Submit a grade using points (float)', () => {
      step('submit a grade using points', async () => {
        setUser(mockStaff[1]);
        score_points = 4.25;
        score_percent = Math.round((score_points / 6) * 10000) / 100;
        feedback_note = 'Test feedback note updated';
        await submitGradeForm('points');
      });

      checkGradingResults(mockStaff[0], mockStaff[1]);
    });

    describe('Using rubric', () => {
      describe('Positive grading', () => {
        step('set rubric settings for positive grading should succeed', async () => {
          setUser(mockStaff[0]);
          const manualGradingIQPage = await (await fetch(manualGradingIQUrl)).text();
          const $manualGradingIQPage = cheerio.load(manualGradingIQPage);
          const form = $manualGradingIQPage('form[name=rubric-settings]');
          rubric_items = [
            { points: 6, description: 'First rubric item' },
            {
              points: 3,
              description: 'Second rubric item (partial, with `markdown`)',
              explanation: 'Explanation with **markdown**',
              grader_note: 'Instructions with *markdown*',
              description_render: 'Second rubric item (partial, with <code>markdown</code>)',
              explanation_render: '<p>Explanation with <strong>markdown</strong></p>',
              grader_note_render: '<p>Instructions with <em>markdown</em></p>',
            },
            {
              points: 0.4,
              description: 'Third rubric item (partial, with moustache: {{params.value1}})',
              explanation: 'Explanation with moustache: {{params.value2}}',
              grader_note:
                'Instructions with *markdown* and moustache: {{params.value3}}\n\nAnd more than one line',
              description_render: 'Third rubric item (partial, with moustache: 37)',
              explanation_render: '<p>Explanation with moustache: 43</p>',
              grader_note_render:
                '<p>Instructions with <em>markdown</em> and moustache: 49</p>\n<p>And more than one line</p>',
            },
            {
              points: -1.6,
              description: 'Penalty rubric item (negative points, floating point)',
            },
            {
              points: 0,
              description: 'Rubric item with no value (zero points)',
            },
          ];

          const response = await fetch(manualGradingIQUrl, {
            method: 'POST',
            headers: { 'Content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              __action: form.find('input[name=__action]').val(),
              __csrf_token: form.find('input[name=__csrf_token]').val(),
              modified_at: form.find('input[name=modified_at]').val(),
              use_rubric: 'true',
              starting_points: '0', // Positive grading
              min_points: '-0.3',
              max_extra_points: '0.3',
              ...buildRubricItemFields(rubric_items),
            }).toString(),
          });

          assert.equal(response.ok, true);
        });

        checkSettingsResults(0, -0.3, 0.3);

        step('submit a grade using a positive rubric', async () => {
          setUser(mockStaff[0]);
          selected_rubric_items = [0, 2, 3];
          score_points = 4.8;
          score_percent = 80;
          feedback_note = 'Test feedback note updated after rubric';
          await submitGradeForm();
        });

        checkGradingResults(mockStaff[0], mockStaff[0]);
      });

      describe('Changing rubric item points', () => {
        step('update rubric items should succeed', async () => {
          setUser(mockStaff[0]);
          const manualGradingIQPage = await (await fetch(manualGradingIQUrl)).text();
          const $manualGradingIQPage = cheerio.load(manualGradingIQPage);
          const form = $manualGradingIQPage('form[name=rubric-settings]');
          rubric_items[2].points = 1;
          score_points = 5.4;
          score_percent = 90;

          const response = await fetch(manualGradingIQUrl, {
            method: 'POST',
            headers: { 'Content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              __action: form.find('input[name=__action]').val(),
              __csrf_token: form.find('input[name=__csrf_token]').val(),
              modified_at: form.find('input[name=modified_at]').val(),
              use_rubric: 'true',
              starting_points: '0', // Positive grading
              min_points: '-0.3',
              max_extra_points: '0.3',
              ...buildRubricItemFields(rubric_items),
            }).toString(),
          });

          assert.equal(response.ok, true);
        });

        checkSettingsResults(0, -0.3, 0.3);
        checkGradingResults(mockStaff[0], mockStaff[0]);
      });

      describe('Using adjust points', () => {
        step('submit a grade using a rubric with adjust points', async () => {
          setUser(mockStaff[3]);
          selected_rubric_items = [1, 3];
          adjust_points = -0.2;
          score_points = 1.2;
          score_percent = 20;
          feedback_note = 'Test feedback note updated after rubric and adjustment';
          await submitGradeForm();
        });

        checkGradingResults(mockStaff[0], mockStaff[3]);
      });

      describe('Floor and ceiling (max/min points)', () => {
        step('submit a grade that reaches the ceiling', async () => {
          setUser(mockStaff[3]);
          selected_rubric_items = [0, 1];
          adjust_points = null;
          score_points = 6.3;
          score_percent = 105;
          feedback_note = 'Test feedback note updated over ceiling';
          await submitGradeForm();
        });

        checkGradingResults(mockStaff[0], mockStaff[3]);

        step('submit a grade that reaches the ceiling with adjust points', async () => {
          setUser(mockStaff[3]);
          selected_rubric_items = [0, 1];
          adjust_points = 1.2;
          score_points = 7.5;
          score_percent = 125;
          feedback_note = 'Test feedback note updated over ceiling and adjustment';
          await submitGradeForm();
        });

        checkGradingResults(mockStaff[0], mockStaff[3]);

        step('update rubric items should succeed', async () => {
          setUser(mockStaff[0]);
          const manualGradingIQPage = await (await fetch(manualGradingIQUrl)).text();
          const $manualGradingIQPage = cheerio.load(manualGradingIQPage);
          const form = $manualGradingIQPage('form[name=rubric-settings]');
          score_points = 6.9;
          score_percent = 115;

          const response = await fetch(manualGradingIQUrl, {
            method: 'POST',
            headers: { 'Content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              __action: form.find('input[name=__action]').val(),
              __csrf_token: form.find('input[name=__csrf_token]').val(),
              modified_at: form.find('input[name=modified_at]').val(),
              use_rubric: 'true',
              starting_points: '0', // Positive grading
              min_points: '-0.3',
              max_extra_points: '-0.3',
              ...buildRubricItemFields(rubric_items),
            }).toString(),
          });

          assert.equal(response.ok, true);
        });

        checkSettingsResults(0, -0.3, -0.3);
        checkGradingResults(mockStaff[0], mockStaff[0]);

        step('submit a grade that reaches the floor', async () => {
          setUser(mockStaff[3]);
          selected_rubric_items = [2, 3];
          adjust_points = null;
          score_points = -0.3;
          score_percent = -5;
          feedback_note = 'Test feedback note updated over ceiling';
          await submitGradeForm();
        });

        checkGradingResults(mockStaff[0], mockStaff[3]);
      });

      describe('Negative grading', () => {
        step('set rubric settings to negative grading should succeed', async () => {
          setUser(mockStaff[0]);
          const manualGradingIQPage = await (await fetch(manualGradingIQUrl)).text();
          const $manualGradingIQPage = cheerio.load(manualGradingIQPage);
          const form = $manualGradingIQPage('form[name=rubric-settings]');
          rubric_items = [
            { points: 0, description: 'First rubric item' },
            {
              points: -3,
              description: 'Second rubric item (partial, with `markdown`)',
              explanation: 'Explanation with **markdown**',
              grader_note: 'Instructions with *markdown*',
              description_render: 'Second rubric item (partial, with <code>markdown</code>)',
              explanation_render: '<p>Explanation with <strong>markdown</strong></p>',
              grader_note_render: '<p>Instructions with <em>markdown</em></p>',
            },
            {
              points: -4,
              description: 'Third rubric item (partial, with moustache: {{params.value1}})',
              explanation: 'Explanation with moustache: {{params.value2}}',
              grader_note:
                'Instructions with *markdown* and moustache: {{params.value3}}\n\nAnd more than one line',
              description_render: 'Third rubric item (partial, with moustache: 37)',
              explanation_render: '<p>Explanation with moustache: 43</p>',
              grader_note_render:
                '<p>Instructions with <em>markdown</em> and moustache: 49</p>\n<p>And more than one line</p>',
            },
            {
              points: 1.6,
              description:
                'Positive rubric item in negative grading (positive points, floating point)',
            },
            {
              points: 6,
              description: 'Rubric item with positive reaching maximum',
            },
          ];

          const response = await fetch(manualGradingIQUrl, {
            method: 'POST',
            headers: { 'Content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              __action: form.find('input[name=__action]').val(),
              __csrf_token: form.find('input[name=__csrf_token]').val(),
              modified_at: form.find('input[name=modified_at]').val(),
              use_rubric: 'true',
              starting_points: '6', // Negative grading
              min_points: '-0.6',
              max_extra_points: '0.6',
              ...buildRubricItemFields(rubric_items),
            }).toString(),
          });

          assert.equal(response.ok, true);
        });

        checkSettingsResults(6, -0.6, 0.6);

        step('submit a grade using a negative rubric', async () => {
          setUser(mockStaff[0]);
          selected_rubric_items = [0, 2, 3];
          adjust_points = null;
          score_points = 3.6;
          score_percent = 60;
          feedback_note = 'Test feedback note updated after negative rubric';
          await submitGradeForm();
        });

        checkGradingResults(mockStaff[0], mockStaff[0]);
      });
    });

    describe('New submission after manual grading', () => {
      step('re-open assessment', async () => {
        setUser(defaultUser);
        const instancesBody = await (await fetch(instancesAssessmentUrl)).text();
        const $instancesBody = cheerio.load(instancesBody);
        const token = $instancesBody('input[name=__csrf_token]').val();
        const response = await fetch(instancesAssessmentUrl, {
          method: 'POST',
          headers: { 'Content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            __action: 'set_time_limit_all',
            __csrf_token: token,
            plus_minus: 'unlimited',
            time_add: '0',
            time_ref: 'minutes',
            reopen_closed: 'on',
          }).toString(),
        });
        assert.equal(response.status, 200);
      });

      step('load page as student', async () => {
        iqUrl = await loadHomeworkQuestionUrl(mockStudents[0]);
        iqId = parseInstanceQuestionId(iqUrl);
        manualGradingIQUrl = `${manualGradingAssessmentUrl}/instance_question/${iqId}`;

        const instance_questions = (await sqldb.queryAsync(sql.get_instance_question, { iqId }))
          .rows;
        assert.lengthOf(instance_questions, 1);
        assert.equal(instance_questions[0].requires_manual_grading, false);
      });

      step('submit an answer to the question', async () => {
        const gradeRes = await saveOrGrade(iqUrl, {}, 'save', [
          { name: 'fib.py', contents: Buffer.from(fibonacciSolution).toString('base64') },
        ]);
        const questionsPage = await gradeRes.text();
        const $questionsPage = cheerio.load(questionsPage);

        assert.equal(gradeRes.status, 200);
        assert.equal(
          getLatestSubmissionStatus($questionsPage),
          'manual grading: waiting for grading',
        );
      });

      step('should tag question as requiring grading', async () => {
        const instanceQuestions = (await sqldb.queryAsync(sql.get_instance_question, { iqId }))
          .rows;
        assert.lengthOf(instanceQuestions, 1);
        assert.equal(instanceQuestions[0].requires_manual_grading, true);
      });

      step('student view should keep the old feedback/rubric', async () => {
        iqUrl = await loadHomeworkQuestionUrl(mockStudents[0]);
        const questionsPage = await (await fetch(iqUrl)).text();
        const $questionsPage = cheerio.load(questionsPage);
        const submissions = $questionsPage('[data-testid="submission-with-feedback"]');
        assert.equal(submissions.eq(0).find('[id^="submission-feedback-"]').length, 0);
        assert.equal(submissions.eq(1).find('[id^="submission-feedback-"]').length, 1);
        assert.equal(
          submissions.eq(1).find('[data-testid="feedback-body"]').first().text().trim(),
          feedback_note,
        );
      });

      step('manual grading page should warn about an open instance', async () => {
        setUser(defaultUser);
        const manualGradingPage = await (await fetch(manualGradingAssessmentUrl)).text();
        $manualGradingPage = cheerio.load(manualGradingPage);
        const row = $manualGradingPage('div.alert:contains("has one open instance")');
        assert.equal(row.length, 1);
      });

      step('manual grading page should list one question requiring grading', async () => {
        const row = $manualGradingPage(`tr:contains("${manualGradingQuestionTitle}")`);
        assert.equal(row.length, 1);
        const count = row.find('td[data-testid="iq-to-grade-count"]').text().replace(/\s/g, '');
        assert.equal(count, '1/1');
        manualGradingAssessmentQuestionUrl =
          siteUrl + row.find(`a:contains("${manualGradingQuestionTitle}")`).attr('href');
        manualGradingNextUngradedUrl = manualGradingAssessmentQuestionUrl + '/next_ungraded';
      });

      step(
        'manual grading page for assessment question should warn about an open instance',
        async () => {
          setUser(defaultUser);
          const manualGradingAQPage = await (
            await fetch(manualGradingAssessmentQuestionUrl)
          ).text();
          const $manualGradingAQPage = cheerio.load(manualGradingAQPage);
          const row = $manualGradingAQPage('div.alert:contains("has one open instance")');
          assert.equal(row.length, 1);
        },
      );

      step('manual grading page for assessment question should list one instance', async () => {
        setUser(defaultUser);
        const manualGradingAQData = await (
          await fetch(manualGradingAssessmentQuestionUrl + '/instances.json')
        ).text();
        const instanceList = JSON.parse(manualGradingAQData)?.instance_questions;
        assert(instanceList);
        assert.lengthOf(instanceList, 1);
        assert.equal(instanceList[0].id, iqId);
        assert.isOk(instanceList[0].requires_manual_grading);
      });

      step(
        'manual grading page for instance question should warn about an open instance',
        async () => {
          setUser(defaultUser);
          const manualGradingIQPage = await (await fetch(manualGradingIQUrl)).text();
          const $manualGradingIQPage = cheerio.load(manualGradingIQPage);
          const row = $manualGradingIQPage('div.alert:contains("is still open")');
          assert.equal(row.length, 1);
        },
      );

      step('submit a new grade', async () => {
        setUser(mockStaff[1]);
        selected_rubric_items = [1, 2, 4];
        adjust_points = null;
        score_points = 5;
        score_percent = 83.33;
        feedback_note = 'Test feedback note for second submission';
        await submitGradeForm();
      });

      checkGradingResults(mockStaff[0], mockStaff[1]);
    });
  });
});
