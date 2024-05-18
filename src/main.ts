import * as core from '@actions/core'
import * as github from '@actions/github'
import * as octokitTypes from '@octokit/openapi-types'
import semver from 'semver/preload'

type Octokit = ReturnType<typeof github.getOctokit>
type PullRequest = octokitTypes.components['schemas']['pull-request']

const patch = 'patch'
const minor = 'minor'
const major = 'major'
const noRelease = 'no-release'

const validLabels = [patch, minor, major, noRelease]

const validatePullRequestLabel = (pr: PullRequest): void => {
  if (!pr.labels.some(it => validLabels.includes(it.name)))
    throw new Error(
      `Please set one of the following label : ${validLabels.join(', ')}`
    )

  const count = pr.labels.filter(it => validLabels.includes(it.name)).length
  if (count !== 1) throw new Error('Exactly one label must be set')
}

const pullRequestFromCommitSha = async (
  octokit: Octokit
): Promise<PullRequest> => {
  // https://docs.github.com/en/rest/commits/commits?apiVersion=2022-11-28#list-pull-requests-associated-with-a-commit

  const prList = await octokit.request(
    'GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls',
    {
      ...github.context.repo,
      commit_sha: github.context.sha,
      headers: {
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }
  )

  if (prList.data.length === 0)
    throw new Error(
      `Cannot find any Pull Request associated with ${github.context.sha}`
    )

  if (prList.data.length !== 1)
    throw new Error(`Multiple Pull Requests found for ${github.context.sha}`)

  return prList.data[0] as PullRequest
}

const getLatestTag = async (octokit: Octokit): Promise<string | null> => {
  let tagsList = await octokit.paginate(
    octokit.rest.repos.listTags,
    {
      ...github.context.repo
    },
    resp => {
      return resp.data.filter(tag => semver.valid(tag.name) !== null)
    }
  )

  tagsList = tagsList.sort((x, y) => semver.compare(x.name, y.name))

  if (tagsList.length === 0) return null

  return tagsList[0].name
}

const publishTag = async (octokit: Octokit, tag: string): Promise<void> => {
  core.info(`Tagging ${github.context.sha} with tag ${tag}`)

  await octokit.rest.git.createRef({
    ...github.context.repo,
    ref: `refs/tags/${tag}`,
    sha: github.context.sha
  })
}

const incrementTag = (tag: string, bump: string): string => {
  const newTag = semver.inc(tag, bump as semver.ReleaseType)
  if (newTag === null)
    throw new Error(`failed to increment tag "${tag}" with bump ${bump}`)

  return newTag
}

const publishGitTag = async (octokit: Octokit): Promise<string> => {
  const pr = await pullRequestFromCommitSha(octokit)

  validatePullRequestLabel(pr)

  const bump = pr.labels.filter(it => validLabels.includes(it.name))[0].name;


  if (bump === noRelease) {
    core.info(`${noRelease} label detected, skipping release`);
    return "";
  }

  const latestTag = await getLatestTag(octokit)
  let newTag: string

  if (latestTag === null) newTag = core.getInput('initial_tag')
  else newTag = incrementTag(latestTag, bump)

  await publishTag(octokit, newTag)

  return newTag
}

const main = async (): Promise<void> => {
  try {
    const octokit = github.getOctokit(core.getInput('github_token'))

    // Running on PR
    if (github.context.payload.pull_request) {
      const pr = await octokit.rest.pulls.get({
        ...github.context.repo,
        pull_number: github.context.payload.pull_request.number
      })

      validatePullRequestLabel(pr.data)

      // PR has been merged
    } else {
      const newTag = await publishGitTag(octokit)
      core.setOutput('tag', newTag)
    }
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

export { main }
